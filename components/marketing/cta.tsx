import { BOOKING_URL, CTA_LABEL } from "@/lib/marketing";

/** The one call to action: "Book a free 20-minute chat", always the booking link, in a new tab. The only signal-blue fill on the page. */
export function Cta({ className = "" }: { className?: string }) {
  return (
    <a href={BOOKING_URL} target="_blank" rel="noopener noreferrer" className={`mk-cta ${className}`}>
      {CTA_LABEL}
    </a>
  );
}
