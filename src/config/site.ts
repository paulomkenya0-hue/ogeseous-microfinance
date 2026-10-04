/**
 * Brand, navigation and copy. Anything here is compiled into the JavaScript bundle, so it is not a
 * secret and can be changed without a new migration.
 *
 * NOTHING INVENTED. The original file said that and then shipped empty contact details, which the
 * site rendered as "To be provided by OGESEOUS" in the footer, the About page and the Contact
 * page. Those blanks are still visible to the public — fill them in before launch.
 *
 * The same values also live in the `app_settings` table (migration 011), where a manager can edit
 * them from /admin/settings without a redeploy. The database copy is authoritative for anything a
 * manager may need to correct at short notice; this file is the fallback and the build-time copy.
 */
export const site = {
  name: 'OGESEOUS MICROFINANCE',
  tagline: 'Empowering Students, Building Futures',
  // The official logo, served from public/assets. BASE_URL is prepended so the URL stays correct
  // when the app is built for a sub-path (GitHub Pages serves /ogeseous-microfinance/).
  logoUrl: `${import.meta.env.BASE_URL}assets/ogeseous-logo.jpg`,
  copyright: '© Paulo Mkenya',
  developer: 'Developed by Paulo Mkenya',

  // TODO(OGESEOUS): all four are still empty and render as placeholders in the footer and on
  // /about and /contact. Fill them in, or set them in /admin/settings.
  contact: {
    phone: '',
    email: '',
    address: '',
    hours: '',
  },

  universities: [
    { name: 'Ruaha Catholic University', code: 'RUCU' },
    { name: 'Mkwawa University College', code: 'MKWAWA' },
    { name: 'Iringa University', code: 'IU' },
  ],
} as const

export const UNIVERSITY_CODES = site.universities.map((u) => u.code)

export const universityName = (code: string | null | undefined): string =>
  site.universities.find((u) => u.code === code)?.name ?? (code ?? '—')

/** Matches the `user_role` enum in the database. Keep the two in step. */
export const STAFF_ROLES = [
  'LOAN_OFFICER',
  'ACCOUNTANT',
  'COLLECTION_OFFICER',
  'MARKETING_OFFICER',
  'MANAGER',
  'SUPER_ADMIN',
] as const

export type StaffRole = (typeof STAFF_ROLES)[number]
export type Role = 'STUDENT' | StaffRole

export const ROLE_LABELS: Record<Role, string> = {
  STUDENT: 'Student',
  LOAN_OFFICER: 'Loan Officer',
  ACCOUNTANT: 'Accountant',
  COLLECTION_OFFICER: 'Collections Officer',
  MARKETING_OFFICER: 'Marketing Officer',
  MANAGER: 'Manager',
  SUPER_ADMIN: 'Super Admin',
}

/** Roles that see the full admin navigation. Mirrors the RLS checks, and is UX only. */
export const FULL_ADMIN_ROLES: readonly StaffRole[] = [
  'LOAN_OFFICER',
  'ACCOUNTANT',
  'COLLECTION_OFFICER',
  'MANAGER',
  'SUPER_ADMIN',
]

export const canSeeFinancials = (role: Role | null | undefined) =>
  role === 'ACCOUNTANT' || role === 'MANAGER' || role === 'SUPER_ADMIN'

export const isSuperAdmin = (role: Role | null | undefined) => role === 'SUPER_ADMIN'
