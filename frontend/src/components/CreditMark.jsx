import ssprLogo from '../assets/sspr-tech-logo.png';
import { CREATOR_URL, CREDIT } from '../version';

/** The SSPR mark. Hover shows who built the app; click opens the creator's site in a new tab. */
export default function CreditMark({ className = 'credit-mark' }) {
  return (
    <a className="credit-mark-link" href={CREATOR_URL} target="_blank" rel="noopener noreferrer" title={`${CREDIT} \u2014 visit sasi.is-a.dev`}>
      <img className={className} src={ssprLogo} alt="SSPR - visit sasi.is-a.dev" />
    </a>
  );
}
