/** OC Next mark: a red roundel with a white sweeping ring, in the spirit of OC Transpo's circle. */
export function Logo({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} role="img" aria-label="OC Next">
      <circle cx="20" cy="20" r="20" fill="#DA291C" />
      <ellipse cx="20" cy="20.5" rx="12.5" ry="9" fill="none" stroke="#fff" strokeWidth="3.4" transform="rotate(-22 20 20)" />
      <circle cx="20" cy="20" r="19.25" fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="1.5" />
    </svg>
  );
}
