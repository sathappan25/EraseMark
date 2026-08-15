export default function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#2563EB" />
      <path
        d="M9 22l3.8-5.1a1.4 1.4 0 012.2 0L17 19.2l1.7-2.1a1.4 1.4 0 012.2 0L24 22"
        stroke="#fff"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12.2" cy="12.2" r="1.6" fill="#fff" />
      <path d="M21 8.4c2 .5 3.4 1.9 3.8 3.9" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
