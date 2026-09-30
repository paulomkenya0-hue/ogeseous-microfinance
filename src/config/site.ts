// Single place to edit brand, logo and contact details. Nothing here is invented: fill in real values.
export const site = {
  name: 'OGESEOUS MICROFINANCE', tagline: 'Empowering Students, Building Futures',
  logoUrl: '' as string, // put the official logo path (e.g. '/logo.png') here when provided
  copyright: '© Paulo Mkenya', developer: 'Developed by Paulo Mkenya',
  contact: { phone: '', email: '', address: '', hours: '' }, // TODO: client to provide
  universities: [
    { name: 'Ruaha Catholic University', code: 'RUCU' },
    { name: 'Mkwawa University College', code: 'MKWAWA' },
    { name: 'Iringa University', code: 'IU' } ],
}
export const STAFF_ROLES = ['LOAN_OFFICER','ACCOUNTANT','COLLECTION_OFFICER','MARKETING_OFFICER','MANAGER','SUPER_ADMIN'] as const
export type Role = 'STUDENT' | typeof STAFF_ROLES[number]
