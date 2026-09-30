export const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
export const isPhone = (v: string) => /^\+?[0-9\s-]{9,15}$/.test(v)
export const strongPw = (v: string) => v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v)
