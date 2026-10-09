import { describe, expect, it } from 'vitest'
import {
  canAccessAdminArea,
  canApproveLoans,
  canDisburseLoans,
  hasPermission,
  ROLE_PERMISSIONS,
} from './site'

describe('RBAC permission matrix', () => {
  it('keeps the CEO-style super-user privilege out of the active role set', () => {
    expect(ROLE_PERMISSIONS).toHaveProperty('LOAN_OFFICER')
    expect(ROLE_PERMISSIONS).toHaveProperty('ACCOUNTANT')
    expect(ROLE_PERMISSIONS).toHaveProperty('COLLECTION_OFFICER')
    expect(ROLE_PERMISSIONS).not.toHaveProperty('CEO')
  })

  it('allows loan officers to submit applications without granting loan approval rights', () => {
    expect(hasPermission('LOAN_OFFICER', 'applications.submit')).toBe(true)
    expect(hasPermission('LOAN_OFFICER', 'loans.approve')).toBe(false)
    expect(canApproveLoans('LOAN_OFFICER')).toBe(false)
  })

  it('limits disbursement permissions to explicit roles and denies students admin access', () => {
    expect(hasPermission('ACCOUNTANT', 'loans.disburse')).toBe(false)
    expect(canDisburseLoans('MANAGER')).toBe(true)
    expect(canAccessAdminArea('STUDENT')).toBe(false)
    expect(canAccessAdminArea('LOAN_OFFICER')).toBe(true)
  })
})
