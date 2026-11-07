"""End-to-end test of the real web UI with headless Chromium (needs `npm run dev` on :5173 and the API on :8000).

  python e2e_ui.py [--headed] [--keep]

Creates a lecture, uploads a diagram + a text note, starts a session, plays simulate.py into it, places the
image, lassos the mitochondrion while lines play, confirms, waits for refine, ends the session and checks the
notes page. Verifies the database, then deletes everything it created (unless --keep).
Screenshots go to ./e2e_shots/. Without Gemini quota every AI step uses its fallback; the test still passes.
"""
import argparse
import io
import math
import os
import subprocess
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image, ImageDraw
from playwright.sync_api import Page, sync_playwright

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / ".env")
from db import get_db  # noqa: E402

WEB = "http://localhost:5173"
API = "http://localhost:8000"
SHOTS = HERE / "e2e_shots"
TITLE = "E2E TEST (auto-deleted)"
# The mitochondrion in the test diagram, normalized to the image: centre and radii of the lasso.
LASSO = (0.755, 0.317, 0.12, 0.11)


def diagram(path: Path) -> None:
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.ellipse((60, 60, 840, 540), outline="black", width=6)
    d.ellipse((330, 220, 530, 380), outline="purple", width=5)
    d.ellipse((600, 150, 760, 230), outline="orange", width=5)
    for i in range(5):
        d.arc((615 + i * 25, 165, 645 + i * 25, 215), 0, 180, fill="orange", width=3)
    d.ellipse((150, 380, 310, 460), outline="green", width=5)
    for x, y, t in [(380, 290, "Nucleus"), (175, 410, "Chloroplast"), (390, 75, "Cell membrane")]:
        d.text((x, y), t, fill="black", font_size=26)
    b = io.BytesIO()
    img.save(b, "PNG")
    path.write_bytes(b.getvalue())


class Run:
    def __init__(self, page: Page):
        self.page = page
        self.problems: list[str] = []
        page.on("console", lambda m: m.type == "error" and self.problems.append(f"console: {m.text[:200]}"))
        page.on("pageerror", lambda e: self.problems.append(f"pageerror: {str(e)[:200]}"))
        page.on("response", self._response)

    def _response(self, r):
        if r.status >= 400 and (r.url.startswith(API) or "supabase.co" in r.url):
            self.problems.append(f"HTTP {r.status} {r.request.method} {r.url[:120]}")

    def step(self, name: str):
        print(f"- {name}", flush=True)

    def shot(self, name: str):
        self.page.screenshot(path=str(SHOTS / f"{name}.png"), full_page=True)


def draw_lasso(page: Page, svg) -> None:
    box = svg.bounding_box()
    cx, cy, rx, ry = LASSO
    pts = [(box["x"] + (cx + rx * math.cos(t)) * box["width"], box["y"] + (cy + ry * math.sin(t)) * box["height"])
           for t in [2 * math.pi * i / 28 for i in range(29)]]
    page.mouse.move(*pts[0])
    page.mouse.down()
    for p in pts[1:]:
        page.mouse.move(*p, steps=2)
    page.mouse.up()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--keep", action="store_true", help="don't delete the test lecture")
    args = ap.parse_args()
    SHOTS.mkdir(exist_ok=True)
    png = SHOTS / "plant_cell.png"
    diagram(png)
    db = get_db()
    lecture_id = session_id = None
    sim = None
    ok = False

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page(viewport={"width": 1366, "height": 1024})
        run = Run(page)
        try:
            run.step("dashboard -> new lecture")
            page.goto(WEB + "/", wait_until="networkidle")
            page.get_by_role("button", name="+ New lecture").click()
            page.wait_for_url("**/prep/**")
            lecture_id = page.url.split("?")[0].rstrip("/").split("/")[-1]

            run.step("prep: title, upload diagram, add text")
            # Wait for the lecture to load (Save enables), or the load overwrites the typed title.
            page.wait_for_function("() => { const b = [...document.querySelectorAll('button')]"
                                   ".find(b => b.textContent.trim() === 'Save'); return b && !b.disabled }")
            page.locator(".prep-title").fill(TITLE)
            page.locator(".prep-title").press("Enter")
            page.locator("input[type=file]").set_input_files(str(png))
            page.locator("textarea").fill("Mitochondria: site of cellular respiration; glucose + oxygen -> ATP.")
            page.get_by_role("button", name="Send").click()
            page.wait_for_function("() => document.querySelectorAll('.exchange').length >= 2", timeout=30_000)
            page.get_by_text("Reading…").first.wait_for(state="detached", timeout=90_000)
            run.shot("1_prep")
            acks = page.locator(".exchange .bubble.ai").all_inner_texts()
            print("  prep acknowledgements:", [a.splitlines()[0] for a in acks])

            run.step("save -> dashboard -> Start on the test lecture")
            page.get_by_role("button", name="Save", exact=True).click()
            page.wait_for_url(WEB + "/")
            row = page.locator("li.list-item").filter(has=page.locator(".list-title", has_text=TITLE))
            row.get_by_role("button", name="Start").click()
            page.wait_for_url("**/teach/**")
            session_id = page.url.rstrip("/").split("/")[-1]
            page.wait_for_function(
                "() => { const i = document.querySelector('button.thumb img'); return i && i.naturalWidth > 0 }",
                timeout=20_000)

            run.step("play simulate.py into the session (a line every 2 s)")
            sim = subprocess.Popen([sys.executable, "simulate.py", session_id, "--every", "2"], cwd=HERE,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

            run.step("tap the thumbnail, tap slot 0")
            page.locator("button.thumb").first.click()
            page.locator(".slot.slot-active").first.wait_for(timeout=5_000)
            page.locator('[data-slot="0"]').click()
            svg = page.locator("svg.drawable").first
            svg.wait_for(timeout=10_000)
            page.wait_for_function("() => [...document.querySelectorAll('.image-block img')].every(i => i.complete)")

            run.step("live speech shows up over realtime")
            page.locator(".board-live span").first.wait_for(timeout=15_000)

            run.step("smart mode, lasso the mitochondrion")
            page.get_by_role("radio", name="Smart annotation").click()
            page.wait_for_timeout(3_000)  # let a couple of lines play before selecting
            draw_lasso(page, svg)
            save = page.get_by_role("button", name="Save annotation")
            save.wait_for(timeout=5_000)
            page.wait_for_timeout(6_000)  # lines spoken while the lasso is open get tagged
            run.shot("2_lasso_pending")
            save.click()

            run.step("wait for /close (badge 'Linking speech…' disappears)")
            page.locator(".lasso-badge").first.wait_for(state="detached", timeout=60_000)

            run.step("wait for simulate.py to finish and refine to absorb all speech")
            out, _ = sim.communicate(timeout=90)
            page.wait_for_function("() => !document.querySelector('.board-live')", timeout=60_000)
            texts = page.locator(".board-text").all_inner_texts()
            print(f"  board: {len(texts)} text blocks; first: {texts[0][:100] if texts else '-'}")
            run.shot("3_board")

            run.step("end session -> notes")
            page.locator(".title-btn").click()
            page.get_by_role("menuitem", name="End session").click()
            page.get_by_role("dialog").get_by_role("button", name="End session").click()
            page.wait_for_url("**/notes/**", timeout=30_000)
            page.locator("article h1").wait_for(timeout=120_000)
            sections = page.locator(".notes-section h2").all_inner_texts()
            notes_title = page.locator("article h1").inner_text()
            print(f"  notes: title={notes_title!r} sections={sections}")
            run.shot("4_notes")

            run.step("hover the annotation in the notes figure")
            lasso = page.locator("path.lasso-confirmed.hoverable").first
            lasso.wait_for(timeout=10_000)
            lasso.hover()
            pop = page.locator(".annotation-popover")
            pop.wait_for(timeout=5_000)
            print("  popover:", pop.inner_text().replace("\n", " | ")[:200])
            run.shot("5_notes_popover")

            run.step("database checks")
            anns = db.table("annotations").select("*").eq("session_id", session_id).execute().data
            segs = db.table("transcript_segments").select("raw_text, annotation_id, text_block_id") \
                .eq("session_id", session_id).execute().data
            blocks = db.table("blocks").select("kind").eq("session_id", session_id).execute().data
            notes = db.table("lecture_notes").select("content").eq("session_id", session_id).execute().data
            ses = db.table("sessions").select("status, ended_at").eq("id", session_id).execute().data[0]
            checks = {
                "one confirmed annotation with a label": len(anns) == 1 and anns[0]["status"] == "confirmed"
                and bool(anns[0]["label"]),
                "annotation has bubble_text": bool(anns and anns[0]["bubble_text"]),
                "bubble is about the lasso, not the nucleus said before it": bool(anns and anns[0]["bubble_text"])
                and not any(w in anns[0]["bubble_text"].lower() for w in ("nucle", "clee us")),
                "notes title is the typed title": notes_title == TITLE,
                "segments linked to it": sum(s["annotation_id"] is not None for s in segs) > 0,
                "all 12 segments refined": len(segs) == 12 and all(s["text_block_id"] for s in segs),
                "1 image block + text blocks": sum(b["kind"] == "image" for b in blocks) == 1
                and sum(b["kind"] == "text" for b in blocks) >= 1,
                "lecture_notes written": bool(notes and notes[0]["content"]["sections"]),
                "session ended": ses["status"] == "ended" and bool(ses["ended_at"]),
            }
            if anns:
                print(f"  annotation: label={anns[0]['label']!r} bubble={str(anns[0]['bubble_text'])[:120]!r}")
            for name, passed in checks.items():
                print(f"  {'PASS' if passed else 'FAIL'}  {name}")
            ok = all(checks.values())
        except Exception as e:  # noqa: BLE001
            print(f"\nSTEP FAILED: {type(e).__name__}: {str(e)[:500]}")
            run.shot("failure")
        finally:
            if sim and sim.poll() is None:
                sim.kill()
            browser.close()
            print("\nproblems seen in the browser:", run.problems or "none")
            if lecture_id and not args.keep:
                files = db.storage.from_("assets").list(lecture_id) or []
                if files:
                    db.storage.from_("assets").remove([f"{lecture_id}/{f['name']}" for f in files])
                db.table("lectures").delete().eq("id", lecture_id).execute()
                print(f"cleaned up lecture {lecture_id} ({len(files)} files)")
    print(f"\nscreenshots: {SHOTS}")
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
