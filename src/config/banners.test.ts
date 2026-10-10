import { describe, expect, it } from 'vitest'
import { HERO_SLIDES, MARQUEE_CARDS } from './banners'

describe('banner artwork', () => {
  it('ships original in-repo SVGs with captions, never empty sources', () => {
    expect(HERO_SLIDES.length).toBeGreaterThanOrEqual(4)
    for (const slide of HERO_SLIDES) {
      expect(slide.src).toMatch(/assets\/banners\/.+\.svg$/)
      expect(slide.alt.length).toBeGreaterThan(8)
      expect(slide.title.length).toBeGreaterThan(2)
      expect(slide.caption.length).toBeGreaterThan(8)
    }
  })

  it('reuses the same licensed sequence for the marquee without inventing extra records', () => {
    expect(MARQUEE_CARDS).toEqual(HERO_SLIDES)
  })
})
