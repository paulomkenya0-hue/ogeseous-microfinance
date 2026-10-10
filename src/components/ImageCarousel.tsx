import { useCallback, useEffect, useRef, useState } from 'react'
import type { BannerSlide } from '../config/banners'
import { IconArrowLeft, IconArrowRight } from './icons'

export default function ImageCarousel({
  slides,
  className = '',
}: {
  slides: BannerSlide[]
  className?: string
}) {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const touchStart = useRef<number | null>(null)
  const reduceMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const go = useCallback(
    (next: number) => {
      if (!slides.length) return
      setIndex((current) => (current + next + slides.length) % slides.length)
    },
    [slides.length],
  )

  useEffect(() => {
    if (reduceMotion || paused || slides.length < 2) return
    const id = window.setInterval(() => go(1), 6000)
    return () => window.clearInterval(id)
  }, [go, paused, reduceMotion, slides.length])

  if (!slides.length) return null
  const slide = slides[index]

  return (
    <section
      className={`relative overflow-hidden rounded-3xl bg-navy shadow-lift ${className}`}
      aria-roledescription="carousel"
      aria-label="OGESEOUS mission banners"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onTouchStart={(e) => {
        touchStart.current = e.changedTouches[0]?.clientX ?? null
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current
        const end = e.changedTouches[0]?.clientX
        touchStart.current = null
        if (start == null || end == null) return
        const delta = start - end
        if (Math.abs(delta) < 40) return
        go(delta > 0 ? 1 : -1)
      }}
    >
      <div className="relative aspect-[21/9] min-h-[220px] w-full md:min-h-[280px]">
        {slides.map((item, i) => (
          <img
            key={item.src}
            src={item.src}
            alt={item.alt}
            className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-700 motion-reduce:transition-none ${
              i === index ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
            loading={i === 0 ? 'eager' : 'lazy'}
          />
        ))}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-navy/80 via-navy/35 to-transparent" />
        <div className="absolute inset-0 flex flex-col justify-end p-6 md:p-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-blue-100">{slide.title}</p>
          <p className="mt-2 max-w-xl text-lg font-semibold text-white md:text-2xl">{slide.caption}</p>
        </div>
      </div>

      {slides.length > 1 && (
        <>
          <button
            type="button"
            className="absolute left-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-white/20 text-white backdrop-blur hover:bg-white/30"
            aria-label="Previous banner"
            onClick={() => go(-1)}
          >
            <IconArrowLeft />
          </button>
          <button
            type="button"
            className="absolute right-3 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/30 bg-white/20 text-white backdrop-blur hover:bg-white/30"
            aria-label="Next banner"
            onClick={() => go(1)}
          >
            <IconArrowRight />
          </button>
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-2">
            {slides.map((item, i) => (
              <button
                key={item.src}
                type="button"
                aria-label={`Show ${item.title}`}
                aria-current={i === index}
                className={`h-2.5 rounded-full transition-all ${
                  i === index ? 'w-7 bg-white' : 'w-2.5 bg-white/50 hover:bg-white/80'
                }`}
                onClick={() => setIndex(i)}
              />
            ))}
          </div>
        </>
      )}
    </section>
  )
}
