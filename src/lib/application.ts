/**
 * Everything about the loan application that is a RULE rather than a VIEW, kept in one pure module
 * so it can be unit-tested and so the wizard, the student's tracking page, the public tracking page
 * and the admin pages cannot drift apart on what a status or a document type means.
 *
 * The database is the authority for what is actually permitted (loan_policy(), the status CHECK
 * constraint, required_document_types()). This file mirrors that vocabulary for rendering only —
 * if the two ever disagree, the database wins and the page shows the error the database gave.
 */

/** Mirrors the status CHECK constraint installed by migration 027. */
export const APPLICATION_STATUSES = [
  'DRAFT',
  'PENDING_LOAN_OFFICER',
  'RETURNED_TO_LOAN_OFFICER',
  'ACTION_REQUIRED',
  'PENDING_MANAGER',
  'PENDING_ACCOUNTANT',
  'RETURNED_TO_ACCOUNTANT',
  'PENDING_TERMS_APPROVAL',
  'TERMS_APPROVED',
  'TERMS_ACCEPTED',
  'DISBURSED',
  'PAID_OFF',
  'CLOSED',
  'REJECTED',
  // Historical statuses. 027 backfills them, but they are kept in the vocabulary so an
  // un-migrated row renders its real state rather than a raw code.
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'COMPLETED',
] as const

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number]

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
  PENDING_LOAN_OFFICER: 'With the loan officer',
  RETURNED_TO_LOAN_OFFICER: 'Returned to the loan officer',
  ACTION_REQUIRED: 'Action required',
  PENDING_MANAGER: 'With the manager',
  PENDING_ACCOUNTANT: 'With the accountant — preparing terms',
  RETURNED_TO_ACCOUNTANT: 'Terms returned to the accountant',
  PENDING_TERMS_APPROVAL: 'Terms awaiting manager approval',
  TERMS_APPROVED: 'Terms awaiting your acceptance',
  TERMS_ACCEPTED: 'Terms accepted — ready to disburse',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DISBURSED: 'Disbursed',
  PAID_OFF: 'Paid off — awaiting final reconciliation',
  COMPLETED: 'Completed',
  CLOSED: 'Closed and reconciled',
}

/** One line a student can read on their dashboard without having to ask the office. */
export const STATUS_EXPLAIN: Record<string, string> = {
  NOT_APPLIED: 'You have not started an application yet.',
  DRAFT: 'Saved but NOT submitted. OGESEOUS cannot see it and it is not being reviewed.',
  SUBMITTED: 'Received. It is in the queue for a loan officer.',
  UNDER_REVIEW: 'A loan officer is assessing your application. Nothing is needed from you right now.',
  PENDING_LOAN_OFFICER: 'A loan officer is assessing your application. Nothing is needed from you right now.',
  RETURNED_TO_LOAN_OFFICER: 'The manager sent this back to the loan officer for a fresh assessment.',
  ACTION_REQUIRED: 'OGESEOUS needs something from you before this can move on. See the note below.',
  PENDING_MANAGER: 'The loan officer has forwarded it. A manager is considering it now.',
  PENDING_ACCOUNTANT: 'The manager approved it. The accountant is preparing your loan terms.',
  RETURNED_TO_ACCOUNTANT: 'The manager asked the accountant to correct the loan terms.',
  PENDING_TERMS_APPROVAL: 'The accountant has prepared your terms and the manager is reviewing them.',
  TERMS_APPROVED: 'Your loan terms are ready. Open your application to read them and accept or decline them.',
  TERMS_ACCEPTED: 'You accepted the terms. The accountant will disburse the money.',
  APPROVED: 'Approved and waiting for disbursement. OGESEOUS will contact you.',
  REJECTED: 'Not approved. The reason is shown below.',
  DISBURSED: 'The money has been sent. See your loan for the repayment schedule.',
  PAID_OFF: 'Every installment is paid. The accountant is doing the final reconciliation.',
  COMPLETED: 'Fully repaid and closed.',
  CLOSED: 'Fully repaid, reconciled and closed. The file is complete.',
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
 * filled in, or one that needs something from them. Mirrors the partial unique index
 * one_open_application_per_student from migration 027, which is what guarantees a student cannot
 * hold two in-progress applications at once. DISBURSED, PAID_OFF, CLOSED and REJECTED are outside it.
 */
export const OPEN_STATUSES = [
  'DRAFT',
  'PENDING_LOAN_OFFICER',
  'RETURNED_TO_LOAN_OFFICER',
  'ACTION_REQUIRED',
  'PENDING_MANAGER',
  'PENDING_ACCOUNTANT',
  'RETURNED_TO_ACCOUNTANT',
  'PENDING_TERMS_APPROVAL',
  'TERMS_APPROVED',
  'TERMS_ACCEPTED',
] as const

/** The statuses each role can act on. Kept here so a page offers only what the database allows. */
export const LOAN_OFFICER_ACTION_STATUSES = ['PENDING_LOAN_OFFICER', 'RETURNED_TO_LOAN_OFFICER'] as const
export const MANAGER_ACTION_STATUSES = ['PENDING_MANAGER'] as const
export const ACCOUNTANT_TERMS_STATUSES = ['PENDING_ACCOUNTANT', 'RETURNED_TO_ACCOUNTANT'] as const
export const MANAGER_TERMS_STATUSES = ['PENDING_TERMS_APPROVAL'] as const
export const STUDENT_TERMS_STATUSES = ['TERMS_APPROVED'] as const
export const ACCOUNTANT_DISBURSE_STATUSES = ['TERMS_ACCEPTED'] as const

/** Mirrors the loan_terms status CHECK from migration 027. */
export const TERMS_STATUS_LABEL: Record<string, string> = {
  DRAFT_TERMS: 'Draft terms',
  PENDING_MANAGER_TERMS: 'Awaiting manager approval',
  APPROVED_TERMS: 'Approved — awaiting student acceptance',
  ACCEPTED_BY_STUDENT: 'Accepted by the student',
  DISBURSED: 'Disbursed',
  VOIDED: 'Voided',
}

/** Mirrors the repayments status CHECK from migration 027. */
export const REPAYMENT_STATUS_LABEL: Record<string, string> = {
  PENDING_VERIFICATION: 'Awaiting verification',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  REVERSED: 'Reversed',
}

/** "1 month", not "1 months". Used anywhere a term is shown. */
export const monthsLabel = (months: number | null | undefined): string =>
  months === null || months === undefined ? '—' : `${months} month${months === 1 ? '' : 's'}`

/**
 * True when a status is one of a role's allowed statuses. The status lists above are typed as
 * literal tuples, so this keeps a page from having to cast a plain string to `never` merely to ask
 * the question. It is still only a rendering convenience — the RPC decides for real.
 */
export const isOneOf = (list: readonly string[], value: string | null | undefined): boolean =>
  value !== null && value !== undefined && list.includes(value)


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

/**
 * The loan step is complete when the server would accept save_application_loan().
 *
 * The amount must be strictly positive, not merely a number. A draft created at step 1 has
 * amount = NULL until step 3, and "0" is not a valid loan either: save_application_loan() refuses
 * both, and migration 025 keeps the table's CHECK (amount > 0). Treating zero as complete here
 * would send a returning student past the step that is supposed to ask for the amount and only
 * fail at submit.
 */
export function loanStepDone(d: DraftFacts): boolean {
  return (
    has(d.amount) && (d.amount ?? 0) > 0 &&
    present(d.purpose, 2) &&
    has(d.repayment_period_months) && (d.repayment_period_months ?? 0) > 0 &&
    (d.purpose !== 'OTHER' || present(d.purpose_other, 3))
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
 * Whether a submitted application can still be edited here. A DRAFT is the student's own work; an
 * ACTION_REQUIRED application is one staff have sent back for a correction. Anything else belongs
 * to staff: a student who could still write to a PENDING_MANAGER application could change the
 * numbers an officer was halfway through assessing. The database enforces the same rule.
 */
export const isEditable = (status: string | null | undefined): boolean =>
  status === 'DRAFT' || status === 'ACTION_REQUIRED'

/**
 * The statuses a loan officer may act on, mirroring forward_application_to_manager() and
 * loan_officer_reject_application(). Kept in the client purely so buttons are not offered; the
 * database refuses regardless.
 */
export const REVIEWABLE: readonly string[] = [...LOAN_OFFICER_ACTION_STATUSES]


/** A mask for a public page: initials only, never a full name. */
export function maskInitials(fullName: string | null | undefined): string {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : ''
  return (first + last).toUpperCase() || '—'
}