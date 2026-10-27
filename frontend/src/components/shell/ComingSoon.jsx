import { Icon } from './Sidebar';

export default function ComingSoon({ module }) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-icon"><Icon name={module.icon} size={28} /></div>
      <h2>{module.label}</h2>
      <p>This module is on its way and will live here, inside the same scheduler.</p>
    </div>
  );
}
