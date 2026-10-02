import { describe, expect, it } from 'vitest'
import {
  contactStepDone,
  documentsStepDone,
  financialStepDone,
  guarantorStepDone,
  isEditable,
  loanStepDone,
  maskInitials,
  missingDocuments,
  nextStep,
  prevStep,
  PROGRESS_ITEMS,
  purposeText,
  resumeStep,
  stepNumber,
  WIZARD_STEPS,
  type DraftFacts,
} from './application'

/** A draft with everything filled in — the baseline each test subtracts from. */
const FULL: DraftFacts = {
  student_confirmed_at: '2026-01-05T09:00:00Z',
  amount: 1_000_000,
  purpose: 'TUITION_FEES',
  purpose_other: null,
  repayment_period_months: 12,
  monthly_income: 250_000,
  income_source: 'SELF_EMPLOYED',
  monthly_expenses: 120_000,
  has_financial_support: false,
  support_amount: null,
  support_source: null,
  guarantor_full_name: 'Joseph Mwakasege',
  guarantor_relationship: 'Uncle',
  guarantor_phone: '0754123456',
  guarantor_national_id: '199812345678',
  guarantor_address: 'Mbeya, Tanzania',
  phone: '0755987654',
  address: 'Nyerere Road, Mbeya',
  emergency_contact_name: null,
  emergency_contact_relationship: null,
  emergency_contact_phone: null,
}

const REQUIRED = ['STUDENT_ID', 'NATIONAL_ID', 'GUARANTOR_ID']
const OPTS = { guarantorRequired: true, requiredDocs: REQUIRED }

describe('step navigation', () => {
  it('walks forward and back through seven steps and stops at both ends', () => {
    expect(WIZARD_STEPS).toHaveLength(7)
    expect(nextStep('student')).toBe('loan')
    expect(nextStep('review')).toBeNull()
    expect(prevStep('student')).toBeNull()
    expect(prevStep('loan')).toBe('student')
    // Back from review returns to documents, never past it.
    expect(prevStep('review')).toBe('documents')
  })

  it('numbers the steps from one, and never reports zero', () => {
    expect(stepNumber('student')).toBe(1)
    expect(stepNumber('review')).toBe(7)
  })

  it('reads as the journey a student is told about, ending on Submitted', () => {
    expect(PROGRESS_ITEMS.map((s) => s.label)).toEqual([
      'Student',
      'Loan Details',
      'Contact',
      'Financial',
      'Guarantor',
      'Documents',
      'Review',
      'Submitted',
    ])
  })

  it('keeps Submitted out of the navigable steps', () => {
    // If it were an eighth WizardStep, nextStep('review') would return it and prevStep would walk
    // back out of a screen that has no form on it.
    expect(WIZARD_STEPS).not.toContain('submitted')
    expect(nextStep('review')).toBeNull()
    expect(PROGRESS_ITEMS).toHaveLength(WIZARD_STEPS.length + 1)
    // Every wizard step appears once, in order, and Submitted is last.
    expect(PROGRESS_ITEMS.slice(0, -1).map((s) => s.key)).toEqual([...WIZARD_STEPS])
  })
})

describe('steps 2 and 4 are independent of each other', () => {
  // The reason the database has save_application_loan() and save_application_financial() rather than
  // one save_application_details(). These are the properties the split was chosen to guarantee; if a
  // future change merges them back, this test is the thing that should be read before doing so.
  const loanOnly: DraftFacts = {
    ...FULL,
    monthly_income: null,
    income_source: null,
    monthly_expenses: null,
    has_financial_support: null,
  }

  it('a finished loan step stays finished when the income fields are still empty', () => {
    // Step 2 has never seen the financial questions. A combined save would either refuse the amount
    // until the student reached step 4, or silently ignore the missing arguments — and a field that
    // can never be cleared is worse than one that must be typed.
    expect(loanStepDone(loanOnly)).toBe(true)
    expect(financialStepDone(loanOnly)).toBe(false)
  })

  it('and the reverse: clearing an income does not un-finish the loan', () => {
    const cleared: DraftFacts = { ...FULL, monthly_income: null, income_source: null }
    expect(financialStepDone(cleared)).toBe(false)
    expect(loanStepDone(cleared)).toBe(true)
  })

  it('asks for the first unfinished step, so a loan-only draft resumes on Financial', () => {
    expect(resumeStep(loanOnly, REQUIRED, OPTS)).toBe('financial')
  })
})

describe('missingDocuments', () => {
  it('reports only required types that are absent', () => {
    expect(missingDocuments(REQUIRED, ['STUDENT_ID'])).toEqual(['NATIONAL_ID', 'GUARANTOR_ID'])
  })

  it('ignores attached documents nobody asked for', () => {
    expect(missingDocuments(REQUIRED, [...REQUIRED, 'OTHER'])).toEqual([])
  })

  it('treats an empty requirement list as satisfied — the officer withdrew the requirement', () => {
    expect(missingDocuments([], [])).toEqual([])
    expect(documentsStepDone([], [])).toBe(true)
  })

  it('asks for OTHER only when the setting says so, which is what the database will do', () => {
    // OTHER is optional by default — the default required_documents setting does not list it. It
    // is not hard-coded as optional, though: if OGESEOUS adds OTHER to required_application_documents
    // then required_document_types() returns it and the database refuses a submission without one,
    // so the wizard must ask. Hard-coding "OTHER is never required" here would strand a student at
    // the last step being told to upload something the form said was optional.
    expect(missingDocuments(['STUDENT_ID', 'NATIONAL_ID'], [])).toEqual(['STUDENT_ID', 'NATIONAL_ID'])
    expect(missingDocuments(['STUDENT_ID', 'OTHER'], [])).toEqual(['STUDENT_ID', 'OTHER'])
    expect(missingDocuments(['STUDENT_ID', 'OTHER'], ['OTHER'])).toEqual(['STUDENT_ID'])
    expect(missingDocuments(['STUDENT_ID', 'OTHER'], ['STUDENT_ID', 'OTHER'])).toEqual([])
  })
})

describe('per-step completeness', () => {
  it('treats a fully filled draft as complete everywhere', () => {
    expect(loanStepDone(FULL)).toBe(true)
    expect(contactStepDone(FULL)).toBe(true)
    expect(financialStepDone(FULL)).toBe(true)
    expect(guarantorStepDone(FULL, true)).toBe(true)
  })

  it('requires a description when the purpose is OTHER', () => {
    expect(loanStepDone({ ...FULL, purpose: 'OTHER', purpose_other: null })).toBe(false)
    expect(loanStepDone({ ...FULL, purpose: 'OTHER', purpose_other: 'ab' })).toBe(false)
    expect(loanStepDone({ ...FULL, purpose: 'OTHER', purpose_other: 'Laptop for coursework' })).toBe(true)
  })

  it('accepts a phone number in any format people type, but not a short one', () => {
    // Public tracking compares the last nine digits; the wizard must accept the same shapes.
    expect(contactStepDone({ ...FULL, phone: '+255 755 987 654' })).toBe(true)
    expect(contactStepDone({ ...FULL, phone: '0755987654' })).toBe(true)
    expect(contactStepDone({ ...FULL, phone: '0755 987' })).toBe(false)
  })

  it('only demands support details when the student said they receive support', () => {
    expect(financialStepDone({ ...FULL, has_financial_support: false })).toBe(true)
    expect(financialStepDone({ ...FULL, has_financial_support: true, support_amount: null })).toBe(false)
    expect(
      financialStepDone({ ...FULL, has_financial_support: true, support_amount: 50_000, support_source: null }),
    ).toBe(false)
    expect(
      financialStepDone({
        ...FULL,
        has_financial_support: true,
        support_amount: 50_000,
        support_source: 'University bursary',
      }),
    ).toBe(true)
  })

  it('rejects a guarantor with a missing field only while the guarantor is required', () => {
    const incomplete = { ...FULL, guarantor_national_id: null }
    expect(guarantorStepDone(incomplete, true)).toBe(false)
    expect(guarantorStepDone(incomplete, false)).toBe(true)
  })
})

describe('resumeStep', () => {
  it('always starts at step 1 when the student record was never confirmed', () => {
    // Even with a complete loan on file: without step 1 the identity behind it is unknown.
    expect(resumeStep({ ...FULL, student_confirmed_at: null }, REQUIRED, OPTS)).toBe('student')
  })

  it('opens the review page when everything is already done', () => {
    expect(resumeStep(FULL, REQUIRED, OPTS)).toBe('review')
  })

  it('does not send a student back over a finished guarantor step when the rule was relaxed', () => {
    const noGuarantor = { ...FULL, guarantor_full_name: null, guarantor_national_id: null }
    expect(resumeStep(noGuarantor, [], { guarantorRequired: false, requiredDocs: [] })).toBe('review')
  })

  it('points at the first unfinished step, not the last one touched', () => {
    expect(resumeStep({ ...FULL, amount: null }, REQUIRED, OPTS)).toBe('loan')
    expect(resumeStep({ ...FULL, address: null }, REQUIRED, OPTS)).toBe('contact')
    expect(resumeStep({ ...FULL, monthly_income: null }, REQUIRED, OPTS)).toBe('financial')
    expect(resumeStep({ ...FULL, guarantor_phone: null }, REQUIRED, OPTS)).toBe('guarantor')
    expect(resumeStep(FULL, ['STUDENT_ID'], OPTS)).toBe('documents')
  })
})

describe('isEditable', () => {
  it('lets a student write only to a DRAFT, whatever else exists', () => {
    expect(isEditable('DRAFT')).toBe(true)
    expect(isEditable('UNDER_REVIEW')).toBe(false)
    expect(isEditable('ACTION_REQUIRED')).toBe(false)
    expect(isEditable('APPROVED')).toBe(false)
    expect(isEditable('REJECTED')).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})

describe('purposeText', () => {
  it('shows the free text for OTHER and a label for everything else', () => {
    expect(purposeText('TUITION_FEES', null)).toContain('tuition')
    expect(purposeText('OTHER', 'Solar lamp')).toBe('Solar lamp')
    // OTHER with no description is still readable rather than blank.
    expect(purposeText('OTHER', null)).toBe('Other')
    expect(purposeText(null, null)).toBe('—')
  })
})

describe('maskInitials', () => {
  it('never returns more than two letters', () => {
    expect(maskInitials('Paulo Mkenya Junior')).toBe('PJ')
    expect(maskInitials('grace')).toBe('G')
    expect(maskInitials('  ')).toBe('—')
    expect(maskInitials(null)).toBe('—')
  })

  it('does not leak a name for single-word names either', () => {
    expect(maskInitials('Mwakasege')).toBe('M')
  })
})