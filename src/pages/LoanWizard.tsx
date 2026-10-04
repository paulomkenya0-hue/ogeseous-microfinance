import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../auth/AuthContext'
import { describeError, rpc, rpcOne, tzs } from '../lib/api'
import { Card, ErrorNote, ReadOnly, Row, Stepper, dateTime } from '../components/ui'
import { hasErrors, type Errors } from '../lib/validate'
import { site, universityName } from '../config/site'
import { discardOwnObjects, openDocument, uploadApplicationDocument } from '../lib/storage'
import {
  ALLOWED_REPAYMENT_MONTHS,
  APP_DOC_HINTS,
  APP_DOC_LABELS,
  APP_DOC_TYPES,
  PROGRESS_ITEMS,
  PURPOSE_LABELS,
  STEP_LABELS,
  WIZARD_STEPS,
  missingDocuments,
  monthLabel,
  needsRegisterLookup,
  nextStep,
  prevStep,
  purposeText,
  resumeStep,
  type AppDocType,
  type DraftFacts,
  type WizardStep,
} from '../lib/application'

// ---------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------

type Profile = {
  full_name: string
  phone: string | null
  address: string | null
  emergency_contact_name: string | null
  emergency_contact_relationship: string | null
  emergency_contact_phone: string | null
  university: string | null
  registration_number: string | null
  form_four_index_number: string | null
  programme: string | null
  year_of_study: string | null
  verification_status: string
}

type Draft = {
  id: string
  status: string
  application_number: string | null
  student_record_id: string | null
  student_confirmed_at: string | null
  verification_method: string | null
  programme: string | null
  year_of_study: string | null
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
}

type Policy = {
  min_amount: number
  max_amount: number
  periods: number[]
  max_active_loans: number
  annual_interest_rate: number
  interest_convention: string
  guarantor_required: boolean
  required_documents: string[]
  purposes: string[]
  income_sources: string[]
}

type DocRow = { doc_type: string; storage_path: string; uploaded_at: string }

const OPEN_STATUSES = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED'] as const
const STEP_LIST = WIZARD_STEPS.map((key) => ({ key, label: STEP_LABELS[key] }))

/**
 * What the wizard assumes when loan_policy() cannot be read.
 *
 * These are the SAME values migration 014 installs as the database default, and they have to match.
 * If the fallback were the looser pair a student would be walked through all seven steps, told at
 * every one of them that they were finished, and then refused at submit by the database for a
 * document the form had never asked for. A fallback that is stricter than the server would instead
 * ask for one document too many — annoying, and recoverable. Stricter is the right direction to fail.
 */
const DEFAULT_REQUIRED_DOCS = ['STUDENT_ID', 'NATIONAL_ID', 'GUARANTOR_ID']
const DEFAULT_GUARANTOR_REQUIRED = true

const num = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
const digits = (s: string): string => s.replace(/\D/g, '')
const tidy = (n: number | null | undefined): string => (n === null || n === undefined ? '' : String(n))

// ---------------------------------------------------------------------------------------

function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <label className="block text-sm font-medium">
      {label}
      {children}
      {hint && !error && <span className="mt-1 block text-xs font-normal text-slate-500">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-xs font-normal text-red-600">
          {error}
        </span>
      )}
    </label>
  )
}

/**
 * The loan application wizard.
 *
 * Everything is persisted to the server as it is entered, so BACK and SAVE & CONTINUE never lose
 * anything and a student who closes the browser on step 4 resumes on step 4 — not on step 1 with an
 * empty form. The wizard's steps and their completion rules live in lib/application.ts, which is
 * unit-tested; this file is the view and the network calls.
 *
 * Two things it deliberately does NOT do:
 *   - it never marks the application as submitted before step 7's button is pressed;
 *   - it never lets the student type a name, registration number or programme when the RUCU
 *     register already holds them. Those come back from the database and are shown read-only.
 */
export default function LoanWizard() {
  const { session } = useAuth()
  const nav = useNavigate()
  const uid = session!.user.id

  const [profile, setProfile] = useState<Profile | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [terminalBefore, setTerminalBefore] = useState<{ application_number: string | null; status: string } | null>(null)
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [docs, setDocs] = useState<Record<string, DocRow | null>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [step, setStep] = useState<WizardStep>('student')
  const [err, setErr] = useState<Errors>({})
  const [note, setNote] = useState('')
  /**
   * Re-checking is a local view toggle, not a database reset.
   *
   * There is deliberately no function that clears student_confirmed_at: an un-confirm endpoint would
   * be one more thing to authorize, and a student pressing the wrong button would leave their
   * application in a state staff have to repair. Instead the button puts the lookup form back on
   * screen; running the lookup again overwrites the confirmation through the same
   * verify_student_from_register() the first time used, which already re-checks that the
   * application is still a draft.
   */
  const [recheck, setRecheck] = useState(false)
  /**
   * The declaration on the review step. A separate flag from the Terms & Conditions checkbox on the
   * old form, because it is a different claim: not "I accept these terms" but "this information is
   * true". The server refuses submission without it, so the button's disabled state is a courtesy
   * and the real gate is p_terms_accepted in submit_loan_application().
   */
  const [declared, setDeclared] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  // Step 1
  const [reg, setReg] = useState('')
  const [lastName, setLastName] = useState('')
  const [declUni, setDeclUni] = useState('')
  const [declName, setDeclName] = useState('')
  const [declReg, setDeclReg] = useState('')
  const [declIndex, setDeclIndex] = useState('')

  /**
   * Which branch step 1 is on is decided by the university, not by a separate switch.
   *
   * There used to be a two-button toggle above two sets of fields, and a university dropdown
   * inside one of them that also listed RUCU. So a student could press "Other university", choose
   * RUCU in that dropdown, and type their own name and registration number — writing RUCU
   * details straight into their profile and marking the application SELF_DECLARED, with the
   * register never consulted. One selector removes that path: choosing RUCU means the register
   * lookup, choosing anything else means the declaration, and there is no way to be in the
   * second branch while holding the first university's name.
   *
   * The database refuses it as well — declare_application_student rejects RUCU in migration 017 —
   * because a rule only a form can break is not a rule.
   */
  const isRucu = needsRegisterLookup(declUni)

  // Steps 3 and 4
  const [amount, setAmount] = useState('')
  const [purpose, setPurpose] = useState('')
  const [purposeOther, setPurposeOther] = useState('')
  const [months, setMonths] = useState('')
  const [income, setIncome] = useState('')
  const [incomeSource, setIncomeSource] = useState('')
  const [expenses, setExpenses] = useState('')
  const [hasSupport, setHasSupport] = useState(false)
  const [supportAmount, setSupportAmount] = useState('')
  const [supportSource, setSupportSource] = useState('')

  // Step 2 — Contact
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [emName, setEmName] = useState('')
  const [emRel, setEmRel] = useState('')
  const [emPhone, setEmPhone] = useState('')

  // Step 5
  const [gName, setGName] = useState('')
  const [gRel, setGRel] = useState('')
  const [gPhone, setGPhone] = useState('')
  const [gId, setGId] = useState('')
  const [gAddress, setGAddress] = useState('')

  const [docBusy, setDocBusy] = useState<Record<string, string>>({})

  // -------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------

  const fetchDocs = useCallback(async (applicationId: string | null): Promise<Record<string, DocRow | null>> => {
    if (!applicationId) return {}
    const { data, error } = await supabase
      .from('loan_documents')
      .select('doc_type,storage_path,uploaded_at')
      .eq('application_id', applicationId)
    if (error) throw new Error(error.message)
    const map: Record<string, DocRow | null> = {}
    for (const t of APP_DOC_TYPES) map[t] = null
    for (const r of (data ?? []) as DocRow[]) map[r.doc_type] = r
    return map
  }, [])

  const loadDocs = useCallback(
    async (applicationId: string | null) => {
      setDocs(await fetchDocs(applicationId))
    },
    [fetchDocs],
  )

  const applyForm = useCallback((p: Profile, d: Draft | null) => {
    setProfile(p)
    setDraft(d)
    if (d) {
      setAmount(tidy(d.amount))
      setPurpose(d.purpose ?? '')
      setPurposeOther(d.purpose_other ?? '')
      setMonths(d.repayment_period_months ? String(d.repayment_period_months) : '')
      setIncome(tidy(d.monthly_income))
      setIncomeSource(d.income_source ?? '')
      setExpenses(tidy(d.monthly_expenses))
      setHasSupport(!!d.has_financial_support)
      setSupportAmount(tidy(d.support_amount))
      setSupportSource(d.support_source ?? '')
      setGName(d.guarantor_full_name ?? '')
      setGRel(d.guarantor_relationship ?? '')
      setGPhone(d.guarantor_phone ?? '')
      setGId(d.guarantor_national_id ?? '')
      setGAddress(d.guarantor_address ?? '')
    }
    setPhone(p.phone ?? '')
    setAddress(p.address ?? '')
    setEmName(p.emergency_contact_name ?? '')
    setEmRel(p.emergency_contact_relationship ?? '')
    setEmPhone(p.emergency_contact_phone ?? '')
    setDeclName(p.full_name ?? '')
    setDeclUni(p.university ?? '')
    setDeclReg(p.registration_number ?? '')
    setDeclIndex(p.form_four_index_number ?? '')
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const pRes = await supabase
        .from('student_profiles')
        .select(
          'full_name,phone,address,emergency_contact_name,emergency_contact_relationship,emergency_contact_phone,university,registration_number,form_four_index_number,programme,year_of_study,verification_status',
        )
        .eq('user_id', uid)
        .single()
      if (pRes.error) throw new Error(pRes.error.message)
      const p = pRes.data as Profile

      const appRes = await supabase
        .from('loan_applications')
        .select('*')
        .eq('user_id', uid)
        .order('created_at', { ascending: false })
        .limit(20)
      if (appRes.error) throw new Error(appRes.error.message)
      const apps = (appRes.data ?? []) as Draft[]

      const open = apps.find((a) => (OPEN_STATUSES as readonly string[]).includes(a.status)) ?? null

      // Anything already in review belongs to staff. Redirect rather than show an editable form
      // whose server calls would all be refused anyway.
      if (open && open.status !== 'DRAFT') {
        nav('/loan/application', { replace: true })
        return
      }

      const latest = apps[0] ?? null
      setTerminalBefore(open ? null : latest)

      // loan_policy() is advisory: the database enforces the limits regardless, so a failure here
      // must not block the wizard — the fields simply fall back to unconstrained placeholders.
      const pol = await rpcOne<Policy>('loan_policy').catch(() => null)
      setPolicy(pol)

      applyForm(p, open)
      // The fetched map is used directly rather than reading `docs` back out of state: setDocs has
      // not taken effect yet at this point in the same tick, and resuming on the wrong step because
      // of that would send a student with three uploaded documents back to step 6.
      const fetchedDocs = await fetchDocs(open?.id ?? null)
      setDocs(fetchedDocs)

      const facts: DraftFacts = {
        student_confirmed_at: open?.student_confirmed_at ?? null,
        amount: open?.amount ?? null,
        purpose: open?.purpose ?? null,
        purpose_other: open?.purpose_other ?? null,
        repayment_period_months: open?.repayment_period_months ?? null,
        monthly_income: open?.monthly_income ?? null,
        income_source: open?.income_source ?? null,
        monthly_expenses: open?.monthly_expenses ?? null,
        has_financial_support: open?.has_financial_support ?? null,
        support_amount: open?.support_amount ?? null,
        support_source: open?.support_source ?? null,
        guarantor_full_name: open?.guarantor_full_name ?? null,
        guarantor_relationship: open?.guarantor_relationship ?? null,
        guarantor_phone: open?.guarantor_phone ?? null,
        guarantor_national_id: open?.guarantor_national_id ?? null,
        guarantor_address: open?.guarantor_address ?? null,
        phone: p.phone,
        address: p.address,
        emergency_contact_name: p.emergency_contact_name,
        emergency_contact_relationship: p.emergency_contact_relationship,
        emergency_contact_phone: p.emergency_contact_phone,
      }
      setStep(
        resumeStep(facts, Object.keys(fetchedDocs).filter((k) => fetchedDocs[k]), {
          guarantorRequired: pol?.guarantor_required ?? DEFAULT_GUARANTOR_REQUIRED,
          requiredDocs: pol?.required_documents ?? DEFAULT_REQUIRED_DOCS,
        }),
      )
    } catch (e) {
      setLoadError(describeError(e))
    } finally {
      setLoading(false)
    }
  }, [uid, nav, applyForm, fetchDocs])

  useEffect(() => {
    void load()
    // Intentionally once: later refreshes happen through the explicit per-step handlers, which also
    // update the form state. Re-running this on every render would wipe in-progress typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // -------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------

  const requiredDocs = policy?.required_documents ?? DEFAULT_REQUIRED_DOCS
  const guarantorRequired = policy?.guarantor_required ?? DEFAULT_GUARANTOR_REQUIRED
  const attached = useMemo(() => Object.entries(docs).filter(([, v]) => v).map(([k]) => k), [docs])
  const missing = useMemo(() => missingDocuments(requiredDocs, attached), [requiredDocs, attached])

  const validate = useCallback(
    (which: WizardStep): Errors => {
      const e: Errors = {}
      if (which === 'loan') {
        const a = num(amount)
        if (a === null) e.amount = 'Enter the amount you need'
        else if (a <= 0) e.amount = 'Enter a number greater than zero'
        else if (policy?.min_amount && a < policy.min_amount) e.amount = `The minimum loan is ${tzs(policy.min_amount)}`
        else if (policy?.max_amount && a > policy.max_amount) e.amount = `The maximum loan is ${tzs(policy.max_amount)}`
        if (!purpose) e.purpose = 'Select what the loan is for'
        if (purpose === 'OTHER' && purposeOther.trim().length < 3) e.purposeOther = 'Describe what the loan is for'
        const m = Number(months)
        if (!months) e.months = 'Select a repayment period'
        else if (policy?.periods?.length && !policy.periods.includes(m)) e.months = 'That repayment period is not offered'
      }
      if (which === 'contact') {
        if (digits(phone).length < 9) e.phone = 'Enter a phone number we can reach you on'
        if (address.trim().length < 3) e.address = 'Enter your current address'
        const anyEmergency = emName.trim() || emRel.trim() || emPhone.trim()
        if (anyEmergency) {
          if (emName.trim().length < 3) e.emName = "Enter your emergency contact's full name, or clear the field"
          if (emRel.trim().length < 2) e.emRel = 'State the relationship'
          if (digits(emPhone).length < 9) e.emPhone = 'Enter a phone number for that contact'
        }
      }
      if (which === 'financial') {
        const inc = num(income)
        const exp = num(expenses)
        if (inc === null || inc < 0) e.income = 'Enter your monthly income (0 if you have none)'
        if (incomeSource.trim().length < 2) e.incomeSource = 'Tell us where that income comes from'
        if (exp === null || exp < 0) e.expenses = 'Enter your monthly expenses'
        if (hasSupport) {
          const s = num(supportAmount)
          if (s === null || s <= 0) e.supportAmount = 'Enter how much support you receive'
          if (supportSource.trim().length < 2) e.supportSource = 'Tell us who provides it'
        }
      }
      if (which === 'guarantor' && guarantorRequired) {
        if (gName.trim().length < 3) e.gName = "Enter your guarantor's full name"
        if (gRel.trim().length < 2) e.gRel = 'State your relationship to the guarantor'
        if (digits(gPhone).length < 9) e.gPhone = 'Enter a number we can reach them on'
        if (gId.trim().length < 5) e.gId = "Enter the guarantor's National ID number"
        if (gAddress.trim().length < 5) e.gAddress = "Enter the guarantor's address"
      }
      if (which === 'documents' && missing.length > 0) {
        e.docs = `Please upload: ${missing.map((m) => APP_DOC_LABELS[m]).join(', ')}`
      }
      return e
    },
    [
      amount, purpose, purposeOther, months, policy, phone, address, emName, emRel, emPhone,
      income, incomeSource, expenses, hasSupport, supportAmount, supportSource,
      guarantorRequired, gName, gRel, gPhone, gId, gAddress, missing,
    ],
  )

  const go = useCallback(
    (to: WizardStep) => {
      setStep(to)
      setErr({})
      setNote('')
      window.scrollTo({ top: 0 })
    },
    [],
  )

  // -------------------------------------------------------------------------------------
  // Step actions
  // -------------------------------------------------------------------------------------

  /** Step 1 — match against the RUCU register, or declare the details for a university it has none for. */
  const runLookup = async () => {
    setNote('')
    setErr({})
    setRecheck(false)

    if (!declUni) return setErr({ declUni: 'Choose your university' })

    if (isRucu) {
      if (reg.trim().length < 3) return setErr({ reg: 'Enter your registration number' })
      if (lastName.trim().length < 2) return setErr({ lastName: 'Enter your last name' })
      setBusy('lookup')

      // try/catch, NOT .catch(() => []).
      //
      // The `.catch` that returned an empty array set the real message and then carried on, so the
      // very next line saw zero rows and overwrote it with "Student record not found". Every
      // failure therefore looked like a failed lookup: a permission refusal, an inactive account,
      // an expired session and a genuinely absent register row all produced the same sentence. The
      // student was told to check their typing when the server had refused the request, and the
      // actual cause was thrown away — which is why this bug was hard to diagnose.
      //
      // "Record not found" is a real answer from the database and only a real answer. Anything else
      // reports what the database actually said.
      type RegisterMatch = {
        rucu_student_id: string
        full_name: string
        registration_number: string
        programme: string | null
        year_of_study: string | null
      }
      let rows: RegisterMatch[]
      try {
        rows = await rpc<RegisterMatch>('verify_student_from_register', {
          p_registration: reg.trim(),
          p_last_name: lastName.trim(),
        })
      } catch (e) {
        setBusy(null)
        return setErr({ form: describeError(e) })
      }
      setBusy(null)

      // Zero rows is the documented "no match". It must never be turned into a record, and the
      // wording says exactly what to check so the student does not simply try a different name.
      if (rows.length === 0) {
        return setErr({ form: 'Student record not found. Please check your registration number and last name.' })
      }
      setNote(`Student found: ${rows[0].full_name}. These details come from the RUCU register and cannot be edited here.`)
      await load()
      go(nextStep('student') ?? 'review')
      return
    }

    const e: Errors = {}
    if (declName.trim().length < 3) e.declName = 'Enter your full name as it appears on your registration'
    if (declReg.trim().length < 3) e.declReg = 'Enter your registration number'
    if (declIndex.trim().length < 3) e.declIndex = 'Enter your Form Four Index Number'
    setErr(e)
    if (hasErrors(e)) return

    setBusy('lookup')
    const { error } = await supabase.rpc('declare_application_student', {
      p_university: declUni,
      p_full_name: declName.trim(),
      p_registration: declReg.trim(),
      p_form_four_index: declIndex.trim(),
    })
    setBusy(null)
    if (error) return setErr({ form: describeError(error) })
    setNote('Details recorded. OGESEOUS staff will confirm them together with your documents when they review your application.')
    await load()
    go(nextStep('student') ?? 'review')
  }

  /**
   * Step 3 and step 4 save through two separate database functions, not one.
   *
   * That mirrors what the wizard actually asks for. Step 3 has never seen the income fields, and a
   * combined function would either refuse to save the amount because income is empty — telling the
   * student to fill in a step they have not reached — or silently ignore the missing arguments,
   * which makes it impossible to clear a field you previously filled in. Each function validates
   * only the group it writes, so pressing BACK to correct an amount never costs you your finances.
   */
  const saveStep = async () => {
    const which: WizardStep = step === 'loan' ? 'loan' : 'financial'
    const e = validate(which)
    setErr(e)
    if (hasErrors(e)) return
    if (!draft) return setErr({ form: 'Confirm your student details first.' })

    setBusy(which)
    const { error } =
      which === 'loan'
        ? await supabase.rpc('save_application_loan', {
            p_amount: num(amount),
            p_purpose: purpose || null,
            p_purpose_other: purpose === 'OTHER' ? purposeOther.trim() : null,
            p_repayment_months: months ? Number(months) : null,
          })
        : await supabase.rpc('save_application_financial', {
            p_monthly_income: num(income),
            p_income_source: incomeSource.trim(),
            p_monthly_expenses: num(expenses),
            p_has_support: hasSupport,
            p_support_amount: hasSupport ? num(supportAmount) : null,
            p_support_source: hasSupport ? supportSource.trim() : null,
          })
    setBusy(null)
    if (error) return setErr({ form: describeError(error) })

    setDirty(false)
    setNote('Saved.')
    await load()
    go(nextStep(which) ?? 'review')
  }

  const saveContact = async () => {
    const e = validate('contact')
    setErr(e)
    if (hasErrors(e)) return

    setBusy('contact')
    const { error } = await supabase.rpc('save_application_contact', {
      p_phone: phone.trim(),
      p_address: address.trim(),
      p_emergency_name: emName.trim(),
      p_emergency_relationship: emRel.trim(),
      p_emergency_phone: emPhone.trim(),
    })
    setBusy(null)
    if (error) return setErr({ form: describeError(error) })

    setDirty(false)
    setNote('Saved. Your phone number is what proves ownership on the public tracking page.')
    await load()
    // Derived from WIZARD_STEPS rather than written out, so reordering the wizard cannot leave a
    // step sending the student to the wrong next page.
    go(nextStep('contact') ?? 'review')
  }

  const saveGuarantor = async () => {
    const e = validate('guarantor')
    setErr(e)
    if (hasErrors(e)) return

    setBusy('guarantor')
    const { error } = await supabase.rpc('save_application_guarantor', {
      p_full_name: gName.trim(),
      p_relationship: gRel.trim(),
      p_phone: gPhone.trim(),
      p_national_id: gId.trim(),
      p_address: gAddress.trim(),
    })
    setBusy(null)
    if (error) return setErr({ form: describeError(error) })

    setDirty(false)
    setNote('Saved.')
    await load()
    go('documents')
  }

  const onFile = async (type: AppDocType, file: File | null) => {
    if (!file || !draft) return
    setDocBusy((s) => ({ ...s, [type]: 'uploading' }))
    let uploaded: string | null = null
    try {
      uploaded = await uploadApplicationDocument(uid, draft.id, type, file)
      const rows = await rpc<{ storage_path: string; replaced_path: string | null }>(
        'attach_application_document',
        { p_application_id: draft.id, p_doc_type: type, p_path: uploaded },
      )
      // The server returns what it replaced so the superseded object can be removed rather than
      // left in the bucket forever, unreferenced by anything.
      const replaced = rows[0]?.replaced_path
      if (replaced) await discardOwnObjects(uid, [replaced])
      await loadDocs(draft.id)
    } catch (e) {
      // If the attach was refused the uploaded object is now an orphan. Remove it — quietly,
      // because the error the student needs to read is the attach failure, not a cleanup failure.
      if (uploaded) await discardOwnObjects(uid, [uploaded])
      setDocBusy((s) => ({ ...s, [type]: describeError(e) }))
      return
    }
    setDocBusy((s) => ({ ...s, [type]: '' }))
  }

  const onView = async (type: AppDocType) => {
    const d = docs[type]
    if (!d) return
    setDocBusy((s) => ({ ...s, [type]: 'opening' }))
    try {
      await openDocument(d.storage_path)
    } catch (e) {
      setDocBusy((s) => ({ ...s, [type]: describeError(e) }))
      return
    }
    setDocBusy((s) => ({ ...s, [type]: '' }))
  }

  /**
   * Set only after submit_loan_application() has returned. Rendering the submitted screen is
   * therefore proof that the database committed — the number shown here is the one the database
   * generated, not one the browser composed. A page that showed a number before the round trip
   * finished could show a number for an application that was never created.
   */
  const [submitted, setSubmitted] = useState<{ number: string; at: string } | null>(null)

  const submit = async () => {
    if (!declared) return setErr({ form: 'You must confirm the information is true and correct before submitting.' })

    const all: Errors = {
      ...validate('loan'),
      ...validate('contact'),
      ...validate('financial'),
      ...validate('guarantor'),
      ...validate('documents'),
    }
    setErr(all)
    if (hasErrors(all)) {
      setNote('Some earlier steps still need attention. Use the numbers above to find them.')
      return
    }
    if (!draft) return setErr({ form: 'Your application could not be found. Please reload and try again.' })

    // Re-save the current values first. Without this a student who edited a figure on step 3 and
    // jumped straight to step 7 by clicking a completed step would submit the older numbers. Both
    // saves are attempted; a failure in one is reported, because submitting figures the student has
    // just corrected on screen but which the server never received would be worse than stopping.
    const loanSave = await supabase.rpc('save_application_loan', {
      p_amount: num(amount),
      p_purpose: purpose || null,
      p_purpose_other: purpose === 'OTHER' ? purposeOther.trim() : null,
      p_repayment_months: months ? Number(months) : null,
    })
    if (loanSave.error) return setErr({ form: describeError(loanSave.error) })

    const finSave = await supabase.rpc('save_application_financial', {
      p_monthly_income: num(income),
      p_income_source: incomeSource.trim(),
      p_monthly_expenses: num(expenses),
      p_has_support: hasSupport,
      p_support_amount: hasSupport ? num(supportAmount) : null,
      p_support_source: hasSupport ? supportSource.trim() : null,
    })
    if (finSave.error) return setErr({ form: describeError(finSave.error) })

    setBusy('submit')
    const { data, error } = await supabase.rpc('submit_loan_application', {
      p_id: draft.id,
      p_terms_accepted: true,
    })
    setBusy(null)
    if (error) return setErr({ form: describeError(error) })

    // Prefer the number the database returned. Falling back to the draft's column covers only the
    // case where the RPC returned no row despite succeeding, which should not happen; if it does,
    // say so rather than navigating to a page that silently has nothing to show.
    const row = (data ?? [])[0] as { application_number: string; status: string; submitted_at: string } | undefined
    if (!row?.application_number) {
      await load()
      nav('/loan/application', { replace: true })
      return
    }

    setDirty(false)
    setSubmitted({ number: row.application_number, at: row.submitted_at })
  }

  // -------------------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------------------

  if (loading) return <p className="p-10 text-center text-slate-500">Loading…</p>

  if (loadError) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Card title="We could not open your application">
          <ErrorNote error={loadError} onRetry={() => void load()} />
          <Link className="btn-blue" to="/dashboard">
            Back to dashboard
          </Link>
        </Card>
      </div>
    )
  }

  /**
 * Whether step 1 should show the confirmed record or the lookup form. `recheck` is set by the
 * "Re-check my record" button and cleared by a successful lookup.
 */
const confirmed = !!draft?.student_confirmed_at && !recheck
  const amountNum = num(amount)
  const monthsNum = Number(months)
  const monthly = amountNum && monthsNum > 0 ? amountNum / monthsNum : 0

  /**
   * The last screen of the journey, and the only one that is not a form.
   *
   * It shows the number the database generated and the status it set. The status is stated as
   * UNDER REVIEW rather than "submitted", because that is what actually happened: nothing is
   * waiting in a queue for someone to pick it up, it is in the reviewer's list now. Saying
   * "submitted" here would promise a step that does not exist.
   */
  if (submitted) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 px-4 py-10">
        {/* The same strip the student walked through, with every step ticked. A different widget
            appearing only at the end would read as a different process rather than the end of this
            one. No onGo: nothing here can be navigated to. */}
        <Stepper labels={PROGRESS_ITEMS} current="submitted" />

        <div className="card border-green-300 bg-green-50">
          <h1 className="text-2xl font-bold text-navy">Application submitted</h1>
          <p className="mt-2 text-sm text-green-900">
            Your application has been received by OGESEOUS Microfinance and is now under review. A
            member of staff will look at it and contact you if anything further is needed.
          </p>
          <p className="mt-5 text-xs uppercase tracking-wide text-green-800">Your application number</p>
          <p className="font-mono text-3xl font-bold text-navy">{submitted.number}</p>
          <p className="mt-2 text-sm">
            Status: <span className="font-semibold">UNDER REVIEW</span>
          </p>
        </div>

        <Card title="Keep this number">
          <p className="text-sm text-slate-600">
            Write it down or photograph this page. Together with the phone number on your account it
            lets you check the status without signing in, from any device — which matters if you
            change phone, lose this one, or simply cannot get online when they want to ask.
          </p>
          <dl className="mt-3">
            <Row label="Submitted">{dateTime(submitted.at)}</Row>
          </dl>
        </Card>

        <div className="flex flex-wrap gap-2">
          <Link className="btn-primary" to="/loan/application">
            VIEW APPLICATION
          </Link>
          <Link className="btn-outline" to="/dashboard">
            Back to dashboard
          </Link>
          <Link className="btn-outline" to="/track">
            Track without signing in
          </Link>
        </div>

        <p className="text-xs text-slate-500">
          Submitting does not mean the loan is approved. Nothing is guaranteed until a decision is
          recorded on your application.
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold text-navy">Loan Application</h1>
        <p className="mt-1 text-sm text-slate-600">
          Seven steps. Everything you enter is saved as you go, and OGESEOUS cannot see any of it
          until you submit on the last step.
        </p>
      </header>

      <div className="card">
        <Stepper labels={STEP_LIST} current={step} onGo={(k) => go(k as WizardStep)} />
        {draft?.status === 'DRAFT' && (
          <p className="mt-3 text-xs text-amber-800">
            This is a draft. It is not submitted, it has not been reviewed, and no decision has been
            made about it.
          </p>
        )}
      </div>

      {note && (
        <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-800">
          {note}
        </p>
      )}

      {terminalBefore && !draft && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">You already applied before.</p>
          <p className="mt-1">
            Your previous application{terminalBefore.application_number ? ` (${terminalBefore.application_number})` : ''}{' '}
            is {terminalBefore.status.toLowerCase().replace('_', ' ')}. You can start a new application
            on this same account — you do not need another one.
          </p>
        </div>
      )}

      {err.form && <ErrorNote error={err.form} />}

      {/* ---------------------------------------------------------------- step 1 */}
      {step === 'student' && (
        <Card
          title="Step 1 — Student"
          hint="Find your record so the application carries the details OGESEOUS already holds."
        >
          {confirmed ? (
            <>
              <dl className="grid gap-4 sm:grid-cols-2">
                <ReadOnly label="Full name" value={profile?.full_name} hint="From the register" />
                <ReadOnly label="University" value={universityName(profile?.university)} />
                <ReadOnly label="Registration number" value={profile?.registration_number} />
                <ReadOnly
                  label="Programme"
                  value={draft?.programme ?? profile?.programme}
                  hint={draft?.programme ?? profile?.programme ? undefined : 'Not in the register'}
                />
                <ReadOnly label="Year of study" value={draft?.year_of_study ?? profile?.year_of_study} />
                <ReadOnly label="Form Four index number" value={profile?.form_four_index_number} />
              </dl>
              <p className="mt-4 text-xs text-slate-500">
                Confirmed {dateTime(draft?.student_confirmed_at)} by{' '}
                {draft?.verification_method === 'RUCU_REGISTER'
                  ? 'matching the RUCU register'
                  : 'your own declaration, to be confirmed by staff during review'}
                . These fields cannot be edited here, on purpose: the application always shows what
                the register shows. If one of them is wrong, contact OGESEOUS.
              </p>
              <div className="mt-4 flex gap-2">
                <button className="btn-primary" onClick={() => go(nextStep('student') ?? 'contact')}>
                  Continue
                </button>
                <button
                  className="btn-outline"
                  onClick={() => {
                    setRecheck(true)
                    setNote('')
                  }}
                  type="button"
                  title="Check the record again, for example if the register has been corrected"
                >
                  Re-check my record
                </button>
              </div>
            </>
          ) : (
            <>
              <Field label="University" error={err.declUni}>
                <select
                  className="input mt-1"
                  value={declUni}
                  onChange={(e) => { setDeclUni(e.target.value); setDirty(true); setErr({}) }}
                >
                  <option value="">Select your university</option>
                  {site.universities.map((u) => (
                    <option key={u.code} value={u.code}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>

              {!declUni ? (
                <p className="mt-4 text-sm text-slate-600">
                  Choose your university above. Ruaha Catholic University students are found in the
                  RUCU register; students of the other universities enter their details themselves.
                </p>
              ) : isRucu ? (
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">
                    Ruaha Catholic University students are checked against the RUCU register, so your
                    details come from the register rather than from what you type. Both fields must
                    match it exactly: a shared surname on its own is not enough, and neither is a
                    registration number on its own.
                  </p>
                  <Field label="Registration Number" error={err.reg}>
                    <input className="input mt-1" value={reg} onChange={(e) => { setReg(e.target.value); setDirty(true) }} />
                  </Field>
                  <Field label="Last Name" error={err.lastName}>
                    <input className="input mt-1" value={lastName} onChange={(e) => { setLastName(e.target.value); setDirty(true) }} />
                  </Field>
                  <button className="btn-primary" disabled={busy !== null} onClick={() => void runLookup()}>
                    {busy === 'lookup' ? 'Searching…' : 'Find my student record'}
                  </button>
                  <p className="text-xs text-slate-500">
                    If nothing is found, nothing is created and no application is started. Contact
                    the OGESEOUS office if your record should be there and is not.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-sm text-slate-600">
                    Mkwawa University College and Iringa University have no register with OGESEOUS, so
                    you enter your own details here. Staff confirm them, together with your documents,
                    while reviewing your application. Nothing you type on this page is treated as
                    verified.
                  </p>
                  <Field label="Full Name" error={err.declName}>
                    <input className="input mt-1" value={declName} onChange={(e) => { setDeclName(e.target.value); setDirty(true) }} />
                  </Field>
                  <Field label="Registration Number" error={err.declReg}>
                    <input className="input mt-1" value={declReg} onChange={(e) => { setDeclReg(e.target.value); setDirty(true) }} />
                  </Field>
                  <Field label="Form Four Index Number" error={err.declIndex}>
                    <input className="input mt-1" value={declIndex} onChange={(e) => { setDeclIndex(e.target.value); setDirty(true) }} />
                  </Field>
                  <button className="btn-primary" disabled={busy !== null} onClick={() => void runLookup()}>
                    {busy === 'lookup' ? 'Saving…' : 'Continue'}
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 3 */}
      {step === 'loan' && (
        <Card title="Step 3 — Loan Details">
          <div className="space-y-3">
            <Field
              label="Amount requested (TZS)"
              error={err.amount}
              hint={
                policy?.min_amount && policy?.max_amount
                  ? `Between ${tzs(policy.min_amount)} and ${tzs(policy.max_amount)}.`
                  : undefined
              }
            >
              <input
                className="input mt-1"
                inputMode="numeric"
                value={amount}
                onChange={(e) => { setAmount(e.target.value.replace(/[^\d]/g, '')); setDirty(true) }}
              />
            </Field>

            <Field label="Purpose" error={err.purpose}>
              <select className="input mt-1" value={purpose} onChange={(e) => { setPurpose(e.target.value); setDirty(true) }}>
                <option value="">Select a purpose</option>
                {(policy?.purposes ?? Object.keys(PURPOSE_LABELS)).map((p) => (
                  <option key={p} value={p}>
                    {PURPOSE_LABELS[p] ?? p}
                  </option>
                ))}
              </select>
            </Field>

            {purpose === 'OTHER' && (
              <Field label="Describe the purpose" error={err.purposeOther}>
                <input className="input mt-1" value={purposeOther} maxLength={200} onChange={(e) => { setPurposeOther(e.target.value); setDirty(true) }} />
              </Field>
            )}

            <Field label="Repayment period" error={err.months}>
              <select className="input mt-1" value={months} onChange={(e) => { setMonths(e.target.value); setDirty(true) }}>
                <option value="">Select a repayment period</option>
                {(policy?.periods?.length ? policy.periods : ALLOWED_REPAYMENT_MONTHS).map((m) => (
                  <option key={m} value={m}>
                    {monthLabel(m)}
                  </option>
                ))}
              </select>
            </Field>

            {monthly > 0 && (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                Roughly {tzs(Math.round(monthly))} a month over {monthLabel(Number(months))}.
                {policy && policy.annual_interest_rate > 0 && (
                  <>
                    {' '}
                    Interest at {policy.annual_interest_rate}% a year (
                    {policy.interest_convention.toLowerCase().replace('_', ' ')}) applies.
                  </>
                )}
                {policy && policy.annual_interest_rate <= 0 && (
                  <> No interest is currently configured, so this figure is the total repaid.</>
                )}
              </p>
            )}

            <StepNav
              back={() => go(prevStep('loan') ?? 'student')}
              saveLabel="Save and continue"
              onSave={() => void saveStep()}
              busy={busy === 'loan'}
              saving={busy !== null}
            />
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 2 */}
      {step === 'contact' && (
        <Card
          title="Step 2 — Contact"
          hint="Already filled in from your account. Only change what is wrong."
        >
          <div className="space-y-3">
            <div className="rounded-lg bg-slate-50 p-3 text-sm">
              <p>
                <span className="font-medium">Email: </span>
                {session?.user.email}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Your email is the login for this account and cannot be changed here.
              </p>
            </div>

            <Field label="Phone number" error={err.phone} hint="Used to prove ownership on the public tracking page.">
              <input className="input mt-1" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setDirty(true) }} />
            </Field>

            <Field label="Current address" error={err.address}>
              <input className="input mt-1" value={address} onChange={(e) => { setAddress(e.target.value); setDirty(true) }} />
            </Field>

            <fieldset className="space-y-3 border-t border-slate-100 pt-3">
              <legend className="text-sm font-medium">Emergency contact</legend>
              <p className="-mt-2 text-xs text-slate-500">
                Optional, but worth filling in. If we cannot reach you and there is a problem with a
                repayment, this is who we call.
              </p>
              <Field label="Full name" error={err.emName}>
                <input className="input mt-1" value={emName} onChange={(e) => { setEmName(e.target.value); setDirty(true) }} />
              </Field>
              <Field label="Relationship" error={err.emRel}>
                <input className="input mt-1" value={emRel} onChange={(e) => { setEmRel(e.target.value); setDirty(true) }} />
              </Field>
              <Field label="Phone number" error={err.emPhone}>
                <input className="input mt-1" inputMode="tel" value={emPhone} onChange={(e) => { setEmPhone(e.target.value); setDirty(true) }} />
              </Field>
            </fieldset>

            <StepNav
              back={() => go(prevStep('contact') ?? 'student')}
              saveLabel="Save and continue"
              onSave={() => void saveContact()}
              busy={busy === 'contact'}
              saving={busy !== null}
            />
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 4 */}
      {step === 'financial' && (
        <Card title="Step 4 — Financial">
          <div className="space-y-3">
            <Field label="Monthly income (TZS)" error={err.income} hint="Enter 0 if you have no income at the moment.">
              <input className="input mt-1" inputMode="numeric" value={income} onChange={(e) => { setIncome(e.target.value.replace(/[^\d]/g, '')); setDirty(true) }} />
            </Field>

            <Field label="Source of income" error={err.incomeSource}>
              <input
                className="input mt-1"
                list="income-sources"
                value={incomeSource}
                onChange={(e) => { setIncomeSource(e.target.value); setDirty(true) }}
              />
              <datalist id="income-sources">
                {(policy?.income_sources ?? []).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </Field>

            <Field label="Monthly expenses (TZS)" error={err.expenses}>
              <input className="input mt-1" inputMode="numeric" value={expenses} onChange={(e) => { setExpenses(e.target.value.replace(/[^\d]/g, '')); setDirty(true) }} />
            </Field>

            {(() => {
              const inc = num(income)
              const exp = num(expenses)
              if (inc === null || exp === null || inc <= 0 || exp <= inc) return null
              return (
                <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
                  Your expenses are more than your income. That is not a reason to be refused — it is
                  something a loan officer will want to discuss with you, and it is worth explaining
                  somewhere in the conversation.
                </p>
              )
            })()}

            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={hasSupport}
                onChange={(e) => { setHasSupport(e.target.checked); setDirty(true) }}
              />
              <span>I receive financial support from someone (a relative, a bursary, an employer)</span>
            </label>

            {hasSupport && (
              <>
                <Field label="Amount of support (TZS, monthly)" error={err.supportAmount}>
                  <input className="input mt-1" inputMode="numeric" value={supportAmount} onChange={(e) => { setSupportAmount(e.target.value.replace(/[^\d]/g, '')); setDirty(true) }} />
                </Field>
                <Field label="Who provides it" error={err.supportSource}>
                  <input className="input mt-1" value={supportSource} onChange={(e) => { setSupportSource(e.target.value); setDirty(true) }} />
                </Field>
              </>
            )}

            <StepNav
              back={() => go(prevStep('financial') ?? 'student')}
              saveLabel="Save and continue"
              onSave={() => void saveStep()}
              busy={busy === 'financial'}
              saving={busy !== null}
            />
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 5 */}
      {step === 'guarantor' && (
        <Card title="Step 5 — Guarantor">
          <div className="space-y-3">
            {!guarantorRequired && (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
                OGESEOUS is not currently asking for a guarantor. You can still fill one in, and it
                will speed things up if the rule is reinstated.
              </p>
            )}
            <Field label="Guarantor full name" error={err.gName}>
              <input className="input mt-1" value={gName} onChange={(e) => { setGName(e.target.value); setDirty(true) }} />
            </Field>
            <Field label="Relationship to you" error={err.gRel}>
              <input className="input mt-1" value={gRel} onChange={(e) => { setGRel(e.target.value); setDirty(true) }} />
            </Field>
            <Field label="Guarantor phone number" error={err.gPhone}>
              <input className="input mt-1" inputMode="tel" value={gPhone} onChange={(e) => { setGPhone(e.target.value); setDirty(true) }} />
            </Field>
            <Field label="Guarantor National ID number" error={err.gId}>
              <input className="input mt-1" value={gId} onChange={(e) => { setGId(e.target.value); setDirty(true) }} />
            </Field>
            <Field label="Guarantor address" error={err.gAddress}>
              <input className="input mt-1" value={gAddress} onChange={(e) => { setGAddress(e.target.value); setDirty(true) }} />
            </Field>

            <StepNav
              back={() => go(prevStep('guarantor') ?? 'student')}
              saveLabel="Save and continue"
              onSave={() => void saveGuarantor()}
              busy={busy === 'guarantor'}
              saving={busy !== null}
            />
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 6 */}
      {step === 'documents' && (
        <Card
          title="Step 6 — Documents"
          hint="Clear photographs or a PDF, 5MB or smaller each. Only staff reviewing your application can open them."
        >
          <div className="space-y-4">
            {err.docs && <ErrorNote error={err.docs} />}
            {APP_DOC_TYPES.map((t) => {
              const d = docs[t]
              const required = requiredDocs.includes(t)
              return (
                <div key={t} className="rounded-lg border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-navy">
                        {APP_DOC_LABELS[t]}{' '}
                        {required ? (
                          <span className="text-xs font-normal text-red-600">required</span>
                        ) : (
                          <span className="text-xs font-normal text-slate-400">optional</span>
                        )}
                      </p>
                      <p className="text-xs text-slate-500">{APP_DOC_HINTS[t]}</p>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {d ? (
                        <>
                          <span className="text-green-700">Uploaded {dateTime(d.uploaded_at)}</span>
                          <button
                            type="button"
                            className="btn-outline px-2 py-1"
                            onClick={() => void onView(t)}
                            disabled={docBusy[t] === 'opening'}
                          >
                            {docBusy[t] === 'opening' ? 'Opening…' : 'View'}
                          </button>
                        </>
                      ) : (
                        <span className="text-slate-400">Not uploaded</span>
                      )}
                    </div>
                  </div>
                  <label className="mt-2 block">
                    <span className="sr-only">Choose a file for {APP_DOC_LABELS[t]}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                      disabled={docBusy[t] === 'uploading'}
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null
                        e.target.value = ''
                        void onFile(t, f)
                      }}
                    />
                  </label>
                  {docBusy[t] && docBusy[t] !== 'uploading' && (
                    <p role="alert" className="mt-1 text-xs text-red-600">{docBusy[t]}</p>
                  )}
                  {docBusy[t] === 'uploading' && <p className="mt-1 text-xs text-slate-500">Uploading…</p>}
                </div>
              )
            })}
            <p className="text-xs text-slate-500">
              Files go into a private bucket and are never given a public link. When you press View, a
              short-lived link is created for that one look and then expires.
            </p>
            <StepNav
              back={() => go(prevStep('documents') ?? 'student')}
              saveLabel="Continue to review"
              onSave={() => {
                const e = validate('documents')
                setErr(e)
                if (!hasErrors(e)) go('review')
              }}
              busy={false}
              saving={false}
            />
          </div>
        </Card>
      )}

      {/* ---------------------------------------------------------------- step 7 */}
      {step === 'review' && (
        <>
          <Card title="Step 7 — Review" hint="Read this as though someone else will read it. Then confirm.">
            <dl>
              <Row label="Student">
                {profile?.full_name} · {universityName(profile?.university)}
              </Row>
              <Row label="Registration number">{profile?.registration_number ?? '—'}</Row>
              <Row label="Programme">
                {draft?.programme ?? profile?.programme ?? <span className="text-slate-400">Not in the register</span>}
              </Row>
              <Row label="Year of study">
                {draft?.year_of_study ?? profile?.year_of_study ?? <span className="text-slate-400">Not in the register</span>}
              </Row>
              <Row label="Phone">{phone || '—'}</Row>
              <Row label="Address">{address || '—'}</Row>
              <Row label="Emergency contact">
                {emName ? `${emName} (${emRel}) ${emPhone}` : <span className="text-slate-400">Not given</span>}
              </Row>
              <Row label="Amount requested">{tzs(amountNum ?? 0)}</Row>
              <Row label="Purpose">{purposeText(purpose, purposeOther)}</Row>
              <Row label="Repayment period">{months ? monthLabel(Number(months)) : '—'}</Row>
              <Row label="Monthly income">{tzs(num(income) ?? 0)}</Row>
              <Row label="Income source">{incomeSource || '—'}</Row>
              <Row label="Monthly expenses">{tzs(num(expenses) ?? 0)}</Row>
              <Row label="Financial support">
                {hasSupport ? `${tzs(num(supportAmount) ?? 0)} from ${supportSource || '—'}` : 'None'}
              </Row>
              <Row label="Guarantor">
                {gName ? `${gName} (${gRel}) · ${gPhone} · ID ${gId} · ${gAddress}` : <span className="text-slate-400">None</span>}
              </Row>
              <Row label="Documents">
                {attached.length === 0
                  ? <span className="text-red-600">None uploaded</span>
                  : attached.map((t) => APP_DOC_LABELS[t as AppDocType]).join(', ')}
              </Row>
            </dl>
          </Card>

          <Card title="Submit">
            <p className="text-sm text-slate-600">
              On submit you will get an application number. Keep it: combined with the phone number
              on your account it is what lets you track this application without signing in.
            </p>

            <label className="mt-4 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={declared} onChange={(e) => setDeclared(e.target.checked)} />
              <span>
                I confirm that the information provided is true and correct.
              </span>
            </label>

            <p className="mt-3 text-xs text-slate-500">
              Submitting also means you accept OGESEOUS Microfinance's{' '}
              <Link className="text-brand underline" to="/terms" target="_blank" rel="noreferrer">
                Terms &amp; Conditions
              </Link>
              .
            </p>

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-outline" onClick={() => go(prevStep('review') ?? 'documents')} disabled={busy !== null}>
                Back
              </button>
              <button className="btn-primary flex-1" disabled={busy !== null || !declared} onClick={() => void submit()}>
                {busy === 'submit' ? 'Submitting…' : 'SUBMIT APPLICATION'}
              </button>
            </div>
            {!declared && <p className="mt-2 text-xs text-slate-500">Tick the declaration above to enable submission.</p>}
          </Card>
        </>
      )}
    </div>
  )
}

function StepNav({
  back,
  onSave,
  saveLabel,
  busy,
  saving,
}: {
  back: () => void
  onSave: () => void
  saveLabel: string
  busy: boolean
  saving: boolean
}) {
  return (
    <div className="flex gap-2 pt-2">
      <button className="btn-outline" onClick={back} disabled={saving}>
        Back
      </button>
      <button className="btn-primary flex-1" onClick={onSave} disabled={saving}>
        {busy ? 'Saving…' : saveLabel}
      </button>
    </div>
  )
}