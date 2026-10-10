/**
 * Brand, navigation and copy. Anything here is compiled into the JavaScript bundle, so it is not a
 * secret and can be changed without a new migration.
 *
 * NOTHING INVENTED. The original file said that and then shipped empty contact details, which the
 * site rendered as "To be provided by OGESEOUS" in the footer, the About page and the Contact
 * page. Those blanks are still visible to the public — fill them in before launch.
 *
 * The same values also live in the `app_settings` table (migration 011), where a Super Admin can
 * edit them from /admin/settings without a redeploy. The database copy is authoritative for any
 * corrections; this file is the fallback and the build-time copy.
 */

export type Permission =
  | 'dashboard.view'
  | 'customers.view'
  | 'customers.create'
  | 'customers.update'
  | 'applications.view'
  | 'applications.create'
  | 'applications.edit'
  | 'applications.submit'
  | 'applications.assess'
  | 'applications.approve'
  | 'applications.disbursement_view'
  | 'loans.view'
  | 'loans.create'
  | 'loans.assess'
  | 'loans.submit_for_approval'
  | 'loans.approve'
  | 'loans.disburse'
  | 'repayments.view'
  | 'repayments.record'
  | 'repayments.reconcile'
  | 'collections.manage'
  | 'collections.view'
  | 'reports.view'
  | 'reports.export'
  | 'marketing.view'
  | 'settings.view'
  | 'accounting.manage'
  | 'bank_reconciliation.manage'
  | 'users.manage'
  | 'roles.manage'
  | 'audit_logs.view'

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
  'CEO',
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
  CEO: 'Chief Executive Officer (CEO)',
  SUPER_ADMIN: 'Super Admin',
}

/** Roles that see the full admin navigation. Mirrors the RLS checks, and is UX only. */
export const FULL_ADMIN_ROLES: readonly StaffRole[] = [
  'LOAN_OFFICER',
  'ACCOUNTANT',
  'COLLECTION_OFFICER',
  'MARKETING_OFFICER',
  'MANAGER',
  'CEO',
  'SUPER_ADMIN',
]

export const hasPermission = (
  role: Role | null | undefined,
  permission: Permission,
): boolean => !!role && (ROLE_PERMISSIONS[role] as readonly Permission[]).includes(permission)

export const hasAnyPermission = (
  role: Role | null | undefined,
  permissions: readonly Permission[],
): boolean => !!role && permissions.some((permission) => hasPermission(role, permission))

export const canAccessAdminArea = (role: Role | null | undefined): boolean =>
  !!role && role !== 'STUDENT'

export const canSeeFinancials = (role: Role | null | undefined) =>
  role === 'ACCOUNTANT' || role === 'MANAGER' || role === 'CEO' || role === 'SUPER_ADMIN'

export const canApproveLoans = (role: Role | null | undefined) =>
  hasPermission(role, 'applications.approve')

export const canDisburseLoans = (role: Role | null | undefined) =>
  hasPermission(role, 'loans.disburse')

export const canManageUsers = (role: Role | null | undefined) =>
  hasPermission(role, 'users.manage')

export const isSuperAdmin = (role: Role | null | undefined) => role === 'SUPER_ADMIN'

export const ROLE_PERMISSIONS = {
  STUDENT: ['customers.view', 'applications.view'] as const,
  LOAN_OFFICER: [
    'dashboard.view',
    'customers.view',
    'applications.view',
    'applications.assess',
    'loans.view',
  ] as const,
  ACCOUNTANT: [
    'dashboard.view',
    'loans.view',
    'loans.disburse',
    'applications.disbursement_view',
    'repayments.view',
    'repayments.record',
    'repayments.reconcile',
    'reports.view',
    'reports.export',
    'accounting.manage',
    'bank_reconciliation.manage',
  ] as const,
  COLLECTION_OFFICER: [
    'dashboard.view',
    'collections.view',
    'collections.manage',
  ] as const,
  MARKETING_OFFICER: [
    'dashboard.view',
    'marketing.view',
  ] as const,
  MANAGER: [
    'dashboard.view',
    'customers.view',
    'applications.view',
    'applications.assess',
    'applications.approve',
    'loans.view',
    'loans.assess',
    'loans.approve',
    'repayments.view',
    'collections.view',
    'collections.manage',
    'reports.view',
    'reports.export',
  ] as const,
  CEO: [
    'dashboard.view',
    'applications.view',
    'applications.approve',
    'loans.view',
    'repayments.view',
    'collections.view',
    'reports.view',
    'reports.export',
  ] as const,
  SUPER_ADMIN: [
    'dashboard.view',
    'customers.view',
    'customers.create',
    'customers.update',
    'applications.view',
    'applications.create',
    'applications.edit',
    'applications.submit',
    'applications.assess',
    'applications.approve',
    'loans.view',
    'loans.create',
    'loans.assess',
    'loans.submit_for_approval',
    'loans.approve',
    'loans.disburse',
    'repayments.view',
    'repayments.record',
    'repayments.reconcile',
    'collections.view',
    'collections.manage',
    'reports.view',
    'reports.export',
    'marketing.view',
    'settings.view',
    'accounting.manage',
    'bank_reconciliation.manage',
    'users.manage',
    'roles.manage',
    'audit_logs.view',
  ] as const,
} as const satisfies Record<Role, readonly Permission[]>
