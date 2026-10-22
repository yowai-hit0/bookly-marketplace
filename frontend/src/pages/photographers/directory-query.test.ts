import { describe, expect, it } from 'vitest'
import {
  activeFilters,
  chipOf,
  dateWindow,
  fieldErrorKeys,
  isWholeAmount,
  onPage,
  pageNumber,
  readQuery,
  withFilters,
  writeQuery,
} from './directory-query'

/** The directory's URL is its state (R6.3): what is read, what is written, and what is never sent. */

describe('reading the URL', () => {
  it('reads every known key', () => {
    const params = new URLSearchParams('category=wedding&district=gasabo&min=20000&max=80000&date=2026-11-07&page=3')
    expect(readQuery(params)).toEqual({ category: 'wedding', district: 'gasabo', min: '20000', max: '80000', date: '2026-11-07', page: '3' })
  })

  it('drops empty and blank values, so none is sent (an empty value is a 400)', () => {
    expect(readQuery(new URLSearchParams('category=&district=%20%20&min=0'))).toEqual({ min: '0' })
  })

  it('drops a key it does not know', () => {
    expect(readQuery(new URLSearchParams('sort=price&utm_source=x&category=wedding'))).toEqual({ category: 'wedding' })
  })

  it('takes a repeated key once, by its first value, so the API never sees it twice', () => {
    expect(readQuery(new URLSearchParams('category=wedding&category=event'))).toEqual({ category: 'wedding' })
  })

  it('passes a malformed value through: the API is the judge', () => {
    expect(readQuery(new URLSearchParams('min=abc&date=yesterday'))).toEqual({ min: 'abc', date: 'yesterday' })
  })
})

describe('writing the URL', () => {
  it('writes the keys in a fixed order', () => {
    expect(writeQuery({ date: '2026-11-07', category: 'wedding', page: '2' }).toString()).toBe('category=wedding&date=2026-11-07&page=2')
  })

  it('never writes an empty value or page 1', () => {
    expect(writeQuery({ category: '', district: ' ', page: '1' }).toString()).toBe('')
  })
})

describe('changing filters', () => {
  it('sets and clears values, and any change starts again at page 1', () => {
    const query = { category: 'wedding', district: 'gasabo', page: '4' }
    expect(withFilters(query, { district: null, min: '20000' })).toEqual({ category: 'wedding', min: '20000' })
    expect(withFilters(query, { category: '' })).toEqual({ district: 'gasabo' })
  })

  it('trims what was typed', () => {
    expect(withFilters({}, { min: ' 25000 ' })).toEqual({ min: '25000' })
  })

  it('moves between pages without touching the filters', () => {
    expect(onPage({ category: 'wedding' }, 2)).toEqual({ category: 'wedding', page: '2' })
  })

  it.each([
    [undefined, 1],
    ['3', 3],
    ['0', 1],
    ['-2', 1],
    ['1.5', 1],
    ['abc', 1],
  ])('reads page %s as %s', (page, expected) => {
    expect(pageNumber(page === undefined ? {} : { page })).toBe(expected)
  })
})

describe('active filters', () => {
  it('is one chip each, with the price range as one', () => {
    expect(activeFilters({})).toEqual([])
    expect(activeFilters({ category: 'wedding', min: '1', max: '2', date: '2026-11-07', page: '2' })).toEqual(['category', 'price', 'date'])
    expect(activeFilters({ max: '50000' })).toEqual(['price'])
  })
})

describe('prices', () => {
  it.each(['0', '25000', '999999999999'])('accepts %s', (value) => expect(isWholeAmount(value)).toBe(true))
  it.each(['', '-5', '1.5', '1e3', '25,000', 'abc', '1000000000000', ' 5'])('refuses %j', (value) => expect(isWholeAmount(value)).toBe(false))
})

describe('the date window', () => {
  it('is today in Kigali to 365 days ahead', () => {
    // 23:30 UTC on 21 October is already 22 October in Kigali.
    expect(dateWindow(new Date('2026-10-21T23:30:00Z'))).toEqual({ min: '2026-10-22', max: '2027-10-22' })
  })
})

describe('the 422 wording', () => {
  it('words each field', () => {
    expect(fieldErrorKeys(['category', 'district', 'date', 'page'], {})).toEqual({
      category: 'directory:invalid.category',
      district: 'directory:invalid.district',
      date: 'directory:invalid.date',
      page: 'directory:invalid.page',
    })
  })

  it('says the lowest is above the highest once, on the price group, when both are named for that', () => {
    expect(fieldErrorKeys(['min', 'max'], { min: '90000', max: '10000' })).toEqual({ price: 'directory:invalid.minAboveMax' })
  })

  it('calls an amount too large when it is named alone, or both are named but in order', () => {
    expect(fieldErrorKeys(['min'], { min: '99999999999' })).toEqual({ min: 'directory:invalid.amount' })
    expect(fieldErrorKeys(['min', 'max'], { min: '99999999999', max: '99999999999' })).toEqual({
      min: 'directory:invalid.amount',
      max: 'directory:invalid.amount',
    })
  })

  it('ignores a field it does not know', () => {
    expect(fieldErrorKeys(['sort'], {})).toEqual({})
  })

  it('ties each field to its chip', () => {
    expect([chipOf('category'), chipOf('min'), chipOf('max'), chipOf('price'), chipOf('date'), chipOf('page')]).toEqual([
      'category',
      'price',
      'price',
      'price',
      'date',
      null,
    ])
  })
})
