/**
 * Everything about the loan application that is a RULE rather than a VIEW, kept in one pure module
 * so it can be unit-tested and so the wizard, the student's tracking page, the public tracking page
 * and the admin pages cannot drift apart on what a status or a document type means.
 *
 * The database is the authority for what is actually permitted (loan_policy(), the status CHECK
 * constraint, required_document_types()). This file mirrors that vocabulary for rendering only —
 * if the two ever disagree, the database wins and the page shows the error the database gave.
 */

/** Mirrors the status CHECK constraint installed by migration 014. */
export const APPLICATION_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'DISBURSED',
  'COMPLETED',
  'CLOSED',
] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

/**
 * The repayment periods the business permits: exactly 1, 2 or 3 months, and nothing else.
 *
 * This mirrors the CHECK constraint on loan_applications.repayment_period_months (004) and the
 * filter inside allowed_repayment_months() (011) — the database stays the authority, and a
 * configured app_settings list can only ever narrow this, never widen it. The wizard's select,
 * the admin settings editor and loanStepDone all read this one constant so they cannot drift.
 */
export const ALLOWED_REPAYMENT_MONTHS = [1, 2, 3] as const

/** True only for 1, 2 or 3. Anything else — 0, negatives, 4+, decimals, NaN — is not a period. */
export const isAllowedRepaymentMonths = (m: number): boolean =>
  (ALLOWED_REPAYMENT_MONTHS as readonly number[]).includes(m)

/** "1 month", "2 months", "3 months" — now that 1 is offered, the plural has to be right. */
export const monthLabel = (m: number): string => (m === 1 ? '1 month' : `${m} months`)

// ---------------------------------------------------------------------------------------
// Which university a student says they attend decides how step 1 behaves.
//
// Ruaha Catholic University is the only institution OGESEOUS holds a register for
// (public.rucu_students). Its students are found by registration number and last name, and their
// name, registration number, programme and year of study are then read-only because they come from
// the register rather than from the keyboard.
//
// The other two have no register with OGESEOUS, so their students enter their own details and staff
// confirm them during review. That is a weaker claim on purpose, and it is recorded as
// SELF_DECLARED, which is why the confirmed panel words the two differently.
//
// RUCU is missing from DECLARABLE_UNIVERSITIES on purpose. It used to appear in the declaration
// dropdown, which meant a student could claim to be an RUCU student and type their own name and
// registration number — writing RUCU details into their profile with the register never consulted.
// declare_application_student() refuses RUCU as well (migration 017), because a rule only a form can
// break is not a rule.
// ---------------------------------------------------------------------------------------
export const DECLARABLE_UNIVERSITIES = ['MKWAWA', 'IU'] as const

/**
 * True when this university must go through the RUCU register lookup.
 *
 * Compared loosely and trimmed, because the value arrives from a <select> that a browser and a
 * restored profile can both fill in inconsistently. RUCU is the only answer that is true; an empty
 * value is false, and the wizard treats that as "nothing chosen yet" rather than as a branch.
 */
export const needsRegisterLookup = (university: string | null | undefined): boolean =>
  (university ?? '').trim().toUpperCase() === 'RUCU'

/**
 * NOT_APPLIED is deliberately absent from the list above, and that is not an oversight: it is not a
 * stored status, it is the absence of a row. Storing it would mean every student who had signed up
 * but not yet applied owned an application, and every query counting applications would be wrong.
 */
export const NOT_APPLIED = 'NOT_APPLIED'

export const STATUS_LABEL: Record<string, string> = {
  NOT_APPLIED: 'Not applied yet',
  DRAFT: 'Draft — not submitted',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  ACTION_REQUIRED: 'Action required',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DISBURSED: 'Disbursed',
  COMPLETED: 'Completed',
  CLOSED: 'Closed',
}

/** One line a student can read on their dashboard without having to ask the office. */
export const STATUS_EXPLAIN: Record<string, string> = {
  NOT_APPLIED: 'You have not started an application yet.',
  DRAFT: 'Saved but NOT submitted. OGESEOUS cannot see it and it is not being reviewed.',
  SUBMITTED: 'Received. It is in the queue for a loan officer.',
  UNDER_REVIEW: 'A loan officer is assessing your application. Nothing is needed from you right now.',
  ACTION_REQUIRED: 'OGESEOUS needs something from you before this can move on. See the note below.',
  APPROVED: 'Approved and waiting for disbursement. OGESEOUS will contact you.',
  REJECTED: 'Not approved. The reason is shown below.',
  DISBURSED: 'The money has been sent. See your loan for the repayment schedule.',
  COMPLETED: 'Fully repaid and closed.',
  CLOSED: 'Closed.',
}

/** Mirrors the purpose CHECK constraint from migration 014. */
export const PURPOSES = [
  'TUITION_FEES',
  'ACCOMMODATION',
  'FOOD_LIVING',
  'BOOKS_AND_MATERIALS',
  'BUSINESS',
  'OTHER',
] as const

export const PURPOSE_LABELS: Record<string, string> = {
  TUITION_FEES: 'Education — tuition fees',
  ACCOMMODATION: 'Accommodation',
  FOOD_LIVING: 'Food and living costs',
  BOOKS_AND_MATERIALS: 'Books and learning materials',
  BUSINESS: 'Business',
  OTHER: 'Other',
}

export const purposeText = (code: string | null | undefined, other: string | null | undefined): string =>
  code === 'OTHER' ? other?.trim() || 'Other' : PURPOSE_LABELS[code ?? ''] ?? code ?? '—'

export const APP_DOC_TYPES = ['STUDENT_ID', 'NATIONAL_ID', 'GUARANTOR_ID', 'OTHER'] as const
export type AppDocType = (typeof APP_DOC_TYPES)[number]

export const APP_DOC_LABELS: Record<AppDocType, string> = {
  STUDENT_ID: 'Student ID',
  NATIONAL_ID: 'National ID (NIDA)',
  GUARANTOR_ID: 'Guarantor ID',
  OTHER: 'Other supporting document',
}

export const APP_DOC_HINTS: Record<AppDocType, string> = {
  STUDENT_ID: 'The student identity card issued by your university.',
  NATIONAL_ID: 'Your National Identification Card, both sides in one photo.',
  GUARANTOR_ID: 'The National ID of the guarantor you named.',
  OTHER: 'Anything else you think we should see. Optional.',
}

export const missingDocuments = (required: readonly string[], attached: readonly string[]): AppDocType[] =>
  APP_DOC_TYPES.filter((t) => required.includes(t) && !attached.includes(t))

/**
 * Statuses in which an application still belongs to the student rather than to staff: a draft being
 * filled in, or one a loan officer is acting on. Mirrors the partial unique index
 * one_open_application_per_student, which is what guarantees a student cannot hold two at once.
 */
export const OPEN_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED'] as const

// ---------------------------------------------------------------------------------------
// The wizard's shape.
//
// Seven steps and a submitted screen, in the order the requirements set out: who and where you
// study, how we reach you, what you want, what you can afford, who backs you, the papers, and then
// a review of everything.
//
// Contact sits second, before Loan Details, where it used to sit third. That is the only ordering
// change and it is deliberate: the number collected on the contact step is what proves ownership on
// the public tracking page, so it is asked for as soon as the student has given their name and
// university rather than after they have already entered an amount and a purpose.
// ---------------------------------------------------------------------------------------
export const WIZARD_STEPS = [
  'student',
  'contact',
  'loan',
  'financial',
  'guarantor',
  'documents',
  'review',
] as const

export type WizardStep = (typeof WIZARD_STEPS)[number]

export const STEP_LABELS: Record<WizardStep, string> = {
  student: 'Student',
  contact: 'Contact',
  loan: 'Loan Details',
  financial: 'Financial',
  guarantor: 'Guarantor',
  documents: 'Documents',
  review: 'Review',
}

/**
 * The progress indicator as a student is meant to read it: the seven steps, then Submitted.
 *
 * Submitted is not a WizardStep — there is nothing to go back to and nothing to edit — so it is a
 * separate item appended here rather than an eighth entry in WIZARD_STEPS, where nextStep() would
 * happily navigate to it and prevStep() would walk back out of it.
 */
export const PROGRESS_ITEMS: { key: string; label: string }[] = [
  ...WIZARD_STEPS.map((key) => ({ key, label: STEP_LABELS[key] })),
  { key: 'submitted', label: 'Submitted' },
]

export const stepNumber = (key: WizardStep): number => WIZARD_STEPS.indexOf(key) + 1

export const nextStep = (key: WizardStep): WizardStep | null => {
  const i = WIZARD_STEPS.indexOf(key)
  return i >= 0 && i < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[i + 1] : null
}

export const prevStep = (key: WizardStep): WizardStep | null => {
  const i = WIZARD_STEPS.indexOf(key)
  return i > 0 ? WIZARD_STEPS[i - 1] : null
}

/**
 * What the wizard needs to know about a stored draft in order to decide which step a returning
 * student should land on. Split out from the page so the decision is testable — this is the logic
 * that decides whether someone who saved three steps ago is asked to re-enter anything.
 */
export type DraftFacts = {
  student_confirmed_at: string | null
  amount: number | null
  purpose: string | null
  purpose_other: string | null
  repayment_period_months: number | null
  monthly_income: number | null
  income_source: string | null
  monthly_expenses: number | null
  has_financial_support: boolean | null
  support_amount: number | null
  support_source: string | null
  guarantor_full_name: string | null
  guarantor_relationship: string | null
  guarantor_phone: string | null
  guarantor_national_id: string | null
  guarantor_address: string | null
  // Contact lives on student_profiles, not on the application.
  phone: string | null
  address: string | null
  emergency_contact_name: string | null
  emergency_contact_relationship: string | null
  emergency_contact_phone: string | null
}

export const digits = (v: string | null | undefined): string => (v ?? '').replace(/\D/g, '')
const present = (v: string | null | undefined, min: number): boolean => (v ?? '').trim().length >= min
const has = (v: number | null | undefined): boolean => typeof v === 'number' && Number.isFinite(v)

/** The loan step is complete when the server would accept save_application_loan(). */
export function loanStepDone(d: DraftFacts): boolean {
  return has(d.amount) && present(d.purpose, 2) &&
    isAllowedRepaymentMonths(d.repayment_period_months ?? NaN) && (
    d.purpose !== 'OTHER' || present(d.purpose_other, 3)
  )
}

export function contactStepDone(d: DraftFacts): boolean {
  return digits(d.phone).length >= 9 && present(d.address, 3)
}

/** The financial step is complete when the server would accept save_application_financial(). */
export function financialStepDone(d: DraftFacts): boolean {
  if (!has(d.monthly_income) || !present(d.income_source, 2) || !has(d.monthly_expenses)) return false
  if (d.has_financial_support) {
    return has(d.support_amount) && (d.support_amount ?? 0) > 0 && present(d.support_source, 2)
  }
  return true
}

export function guarantorStepDone(d: DraftFacts, required: boolean): boolean {
  if (!required) return true
  return (
    present(d.guarantor_full_name, 3) &&
    present(d.guarantor_relationship, 2) &&
    digits(d.guarantor_phone).length >= 9 &&
    present(d.guarantor_national_id, 5) &&
    present(d.guarantor_address, 5)
  )
}

export function documentsStepDone(attached: readonly string[], required: readonly string[]): boolean {
  return missingDocuments(required, attached).length === 0
}

/**
 * Where to open the wizard for a returning student: the first step they have not finished.
 * A student who has never confirmed their record always lands on step 1, whatever else is stored,
 * because nothing downstream of it can be trusted without it.
 */
export function resumeStep(
  d: DraftFacts,
  attached: readonly string[],
  opts: { guarantorRequired: boolean; requiredDocs: readonly string[] },
): WizardStep {
  if (!present(d.student_confirmed_at, 1)) return 'student'
  if (!loanStepDone(d)) return 'loan'
  if (!contactStepDone(d)) return 'contact'
  if (!financialStepDone(d)) return 'financial'
  if (!guarantorStepDone(d, opts.guarantorRequired)) return 'guarantor'
  if (!documentsStepDone(attached, opts.requiredDocs)) return 'documents'
  return 'review'
}

/**
 * Whether a submitted application can still be edited here. Anything that is not a DRAFT belongs
 * to staff: a student who could still write to an UNDER_REVIEW application could change the numbers
 * an officer was halfway through assessing.
 */
export const isEditable = (status: string | null | undefined): boolean => status === 'DRAFT'

/**
 * The statuses an officer may still act on. Mirrors the guard inside review_loan_application().
 * Kept in the client purely so the buttons are not offered; the database refuses regardless.
 */
export const REVIEWABLE: readonly string[] = ['SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED']

/** A mask for a public page: initials only, never a full name. */
export function maskInitials(fullName: string | null | undefined): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase() || '—'
}