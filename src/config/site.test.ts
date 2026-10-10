import { describe, expect, it } from 'vitest'
import {
  canAccessAdminArea,
  canApproveLoans,
  canDisburseLoans,
  hasPermission,
  ROLE_PERMISSIONS,
} from './site'

describe('RBAC permission matrix', () => {
  it('includes CEO and all operational roles in the staff matrix', () => {
    expect(ROLE_PERMISSIONS).toHaveProperty('LOAN_OFFICER')
    expect(ROLE_PERMISSIONS).toHaveProperty('ACCOUNTANT')
    expect(ROLE_PERMISSIONS).toHaveProperty('COLLECTION_OFFICER')
    expect(ROLE_PERMISSIONS).toHaveProperty('CEO')
  })

  it('limits loan officers to verification, application review, and active loans', () => {
    expect(hasPermission('LOAN_OFFICER', 'customers.view')).toBe(true)
    expect(hasPermission('LOAN_OFFICER', 'applications.view')).toBe(true)
    expect(hasPermission('LOAN_OFFICER', 'loans.view')).toBe(true)
    expect(hasPermission('LOAN_OFFICER', 'loans.approve')).toBe(false)
    expect(hasPermission('LOAN_OFFICER', 'repayments.view')).toBe(false)
    expect(hasPermission('LOAN_OFFICER', 'collections.view')).toBe(false)
    expect(hasPermission('LOAN_OFFICER', 'reports.view')).toBe(false)
    expect(canApproveLoans('LOAN_OFFICER')).toBe(false)
  })

  it('limits accountants to finance and collections officers to collections only', () => {
    expect(canDisburseLoans('ACCOUNTANT')).toBe(true)
    expect(hasPermission('ACCOUNTANT', 'applications.disbursement_view')).toBe(true)
    expect(hasPermission('ACCOUNTANT', 'repayments.record')).toBe(true)
    expect(hasPermission('ACCOUNTANT', 'applications.view')).toBe(false)
    expect(hasPermission('ACCOUNTANT', 'applications.approve')).toBe(false)
    expect(hasPermission('ACCOUNTANT', 'collections.view')).toBe(false)
    expect(hasPermission('ACCOUNTANT', 'settings.view')).toBe(false)
    expect(hasPermission('COLLECTION_OFFICER', 'collections.manage')).toBe(true)
    expect(hasPermission('COLLECTION_OFFICER', 'repayments.view')).toBe(false)
    expect(hasPermission('COLLECTION_OFFICER', 'repayments.record')).toBe(false)
    expect(hasPermission('COLLECTION_OFFICER', 'loans.view')).toBe(false)
    expect(hasPermission('COLLECTION_OFFICER', 'reports.view')).toBe(false)
  })

  it('gives the CEO final approval and oversight without system administration', () => {
    expect(canApproveLoans('CEO')).toBe(true)
    expect(hasPermission('CEO', 'reports.view')).toBe(true)
    expect(hasPermission('CEO', 'collections.view')).toBe(true)
    expect(canDisburseLoans('CEO')).toBe(false)
    expect(hasPermission('CEO', 'settings.view')).toBe(false)
    expect(hasPermission('CEO', 'audit_logs.view')).toBe(false)
    expect(hasPermission('CEO', 'users.manage')).toBe(false)
  })

  it('keeps managers out of settings and audit logs and grants super admins full access', () => {
    expect(hasPermission('MANAGER', 'applications.approve')).toBe(true)
    expect(hasPermission('MANAGER', 'repayments.record')).toBe(false)
    expect(canDisburseLoans('MANAGER')).toBe(false)
    expect(hasPermission('MANAGER', 'settings.view')).toBe(false)
    expect(hasPermission('MANAGER', 'audit_logs.view')).toBe(false)
    expect(hasPermission('MANAGER', 'users.manage')).toBe(false)
    expect(hasPermission('MANAGER', 'marketing.view')).toBe(false)
    expect(hasPermission('SUPER_ADMIN', 'settings.view')).toBe(true)
    expect(hasPermission('SUPER_ADMIN', 'audit_logs.view')).toBe(true)
    expect(hasPermission('SUPER_ADMIN', 'marketing.view')).toBe(true)
    expect(canAccessAdminArea('STUDENT')).toBe(false)
    expect(canAccessAdminArea('LOAN_OFFICER')).toBe(true)
  })
})
