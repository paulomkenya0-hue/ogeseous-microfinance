import type { BannerSlide } from '../config/banners'

export default function MarqueeStrip({ cards }: { cards: BannerSlide[] }) {
  if (!cards.length) return null
  const loop = [...cards, ...cards]

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/20 bg-navy/80 py-4 shadow-card backdrop-blur">
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-navy to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-navy to-transparent" />
      <div className="marquee-track flex w-max gap-4 px-4 motion-safe:animate-marquee hover:[animation-play-state:paused]">
        {loop.map((card, i) => (
          <article
            key={`${card.src}-${i}`}
            className="relative h-28 w-52 shrink-0 overflow-hidden rounded-xl ring-1 ring-white/20"
          >
            <img src={card.src} alt="" className="h-full w-full object-cover opacity-80" loading="lazy" />
            <div className="absolute inset-0 bg-navy/45" />
            <p className="absolute inset-x-3 bottom-2 text-sm font-semibold text-white">{card.title}</p>
          </article>
        ))}
      </div>
    </div>
  )
}
