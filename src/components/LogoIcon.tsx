export function LogoIcon() {
  return (
    <svg
      className="brand-logo"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2.5L21.1 7.8L21.1 18.2L12 23.5L2.9 18.2L2.9 7.8Z" />
      <path d="M12 6.5L17.5 9.5L17.5 15.5L12 18.5L6.5 15.5L6.5 9.5Z" strokeOpacity="0.3" strokeWidth="1" />
      <circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="0.8" />
      <circle cx="12" cy="13" r="2" fill="currentColor" />
      <circle cx="12" cy="13" r="0.8" fill="var(--bg)" />
    </svg>
  );
}
