/**
 * Original in-repo artwork for the public and staff banners.
 * These SVGs were drawn for OGESEOUS; they are not third-party photographs.
 * Do not swap them for copyrighted stock photos.
 */
export type BannerSlide = {
  src: string
  alt: string
  title: string
  caption: string
}

const asset = (file: string) => `${import.meta.env.BASE_URL}assets/banners/${file}`

export const HERO_SLIDES: BannerSlide[] = [
  {
    src: asset('education.svg'),
    alt: 'Students walking toward a university campus',
    title: 'Education',
    caption: 'Responsible student lending for universities in Iringa.',
  },
  {
    src: asset('entrepreneurship.svg'),
    alt: 'A graduate planning a small business',
    title: 'Entrepreneurship',
    caption: 'Support for students building skills and livelihoods.',
  },
  {
    src: asset('agriculture.svg'),
    alt: 'Farm fields under a Tanzanian sky',
    title: 'Agriculture',
    caption: 'Lending that stays connected to families and the land.',
  },
  {
    src: asset('small-business.svg'),
    alt: 'A small shop serving the local community',
    title: 'Small business',
    caption: 'Clear terms, tracked applications, and scheduled repayments.',
  },
  {
    src: asset('customer-success.svg'),
    alt: 'A student celebrating a completed study term',
    title: 'Customer success',
    caption: 'From application number to repaid loan — one record, one office.',
  },
]

export const MARQUEE_CARDS: BannerSlide[] = HERO_SLIDES
