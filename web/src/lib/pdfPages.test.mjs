import assert from 'node:assert/strict'
import test from 'node:test'

import { pageInfo, pageLabel, pagesOf, pdfFirstBlockOnBoard, pdfPagesReady, slotPositions } from './pdfPages.ts'

const pdf = { id: 'pdf', kind: 'pdf', file_name: 'forces.pdf', label: 'Forces', page_count: 3 }
const page = (n, source = 'pdf') => ({ id: `${source}-p${n}`, kind: 'pdf_page', source_asset_id: source, page_number: n })
const assets = { pdf, 'pdf-p1': page(1), 'pdf-p2': page(2), 'pdf-p3': page(3), img: { id: 'img', kind: 'image' } }

test('a PDF lists its own pages in page order, not other PDFs’ or images', () => {
  const list = [page(3), page(1), page(1, 'other'), assets.img, page(2)]
  assert.deepEqual(pagesOf(list, 'pdf').map((p) => p.page_number), [1, 2, 3])
})

test('a PDF is ready only when every page has been rendered', () => {
  assert.equal(pdfPagesReady(pdf, [page(1), page(2), page(3)]), true)
  assert.equal(pdfPagesReady(pdf, [page(1), page(2)]), false) // still rendering / partial failure
  assert.equal(pdfPagesReady({ ...pdf, page_count: null }, [page(1)]), false) // uploaded before this feature
  assert.equal(pdfPagesReady({ ...pdf, page_count: 2 }, [page(1), page(3)]), false)
})

test('one block uses the board’s existing slot rule', () => {
  assert.deepEqual(slotPositions(undefined, undefined, 1), [1])
  assert.deepEqual(slotPositions(undefined, 5, 1), [4])
  assert.deepEqual(slotPositions(5, undefined, 1), [6])
  assert.deepEqual(slotPositions(2, 3, 1), [2.5])
})

test('all pages of a PDF fit in one slot, in order, between the neighbours', () => {
  assert.deepEqual(slotPositions(undefined, undefined, 3), [1, 2, 3])
  assert.deepEqual(slotPositions(5, undefined, 3), [6, 7, 8])
  assert.deepEqual(slotPositions(undefined, 1, 3), [-2, -1, 0])
  const between = slotPositions(2, 3, 4)
  assert.deepEqual(between, [...between].sort((a, b) => a - b))
  assert.ok(between[0] > 2 && between.at(-1) < 3)
  assert.equal(new Set(between).size, 4)
})

test('a page block knows its PDF, number and count; ordinary images do not', () => {
  assert.deepEqual(pageInfo({ kind: 'image', asset_id: 'pdf-p2' }, assets), {
    pdfId: 'pdf',
    pageNumber: 2,
    pageCount: 3,
    fileName: 'forces.pdf',
  })
  assert.equal(pageInfo({ kind: 'image', asset_id: 'img' }, assets), null)
  assert.equal(pageInfo({ kind: 'text', asset_id: null }, assets), null)
  assert.equal(pageLabel({ pageNumber: 2, pageCount: 3 }), 'Page 2 of 3')
  assert.equal(pageLabel({ pageNumber: 2, pageCount: null }), 'Page 2')
})

test('finds a PDF already on the board so it is not placed twice', () => {
  const blocks = [
    { id: 'b-img', kind: 'image', asset_id: 'img' },
    { id: 'b-p1', kind: 'image', asset_id: 'pdf-p1' },
  ]
  assert.equal(pdfFirstBlockOnBoard(blocks, assets, 'pdf'), 'b-p1')
  assert.equal(pdfFirstBlockOnBoard(blocks, assets, 'other'), null)
})
