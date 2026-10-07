import { describe, expect, it } from 'vitest'
import { normalizeRucuStudentRow } from './rucuImport'

describe('normalizeRucuStudentRow', () => {
  it('maps the supplied RUCU register headings and joins name columns', () => {
    expect(
      normalizeRucuStudentRow({
        'REGISTRATION NO': 'RU/CLW/2025/005',
        FNAME: 'Linda',
        MNAME: 'Paul',
        LNAME: 'Msakwa',
        PROGRAMME: 'CLW',
        YEAR: '2',
      }),
    ).toEqual({
      form_four_index_number: '',
      registration_number: 'RU/CLW/2025/005',
      last_name: 'Msakwa',
      full_name: 'Linda Paul Msakwa',
      programme: 'CLW',
      year_of_study: '2',
    })
  })

  it('continues to accept the original canonical headings', () => {
    expect(
      normalizeRucuStudentRow({
        form_four_index_number: 'S1234/0012/2022',
        registration_number: 'RU/CLW/2025/005',
        last_name: 'Msakwa',
        full_name: 'Linda Paul Msakwa',
      }).full_name,
    ).toBe('Linda Paul Msakwa')
  })
})