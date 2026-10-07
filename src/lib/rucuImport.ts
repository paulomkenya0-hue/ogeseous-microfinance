export type RucuStudentImportRow = {
  form_four_index_number: string
  registration_number: string
  last_name: string
  full_name: string
  programme: string
  year_of_study: string
}

const normalizeHeader = (header: string) => header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')

export function normalizeRucuStudentRow(row: Record<string, string>): RucuStudentImportRow {
  const values = new Map(Object.entries(row).map(([header, value]) => [normalizeHeader(header), value.trim()]))
  const get = (...headers: string[]) => headers.map((header) => values.get(header)).find(Boolean) ?? ''
  const firstName = get('first_name', 'fname', 'given_name')
  const middleName = get('middle_name', 'mname')
  const lastName = get('last_name', 'lname', 'surname')

  return {
    form_four_index_number: get('form_four_index_number', 'form4_index_number'),
    registration_number: get('registration_number', 'registration_no', 'reg_no'),
    last_name: lastName,
    full_name: get('full_name') || [firstName, middleName, lastName].filter(Boolean).join(' '),
    programme: get('programme', 'program'),
    year_of_study: get('year_of_study', 'year', 'study_year'),
  }
}