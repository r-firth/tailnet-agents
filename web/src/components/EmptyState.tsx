import { useStore, openOverlay } from '../store';
import { useTheme } from '../theme';
import { Dither } from './Dither';
import { Composer } from './Chat';
import { IBrowser, IHand, ITelegram } from '../icons';
import { gbp } from '../format';

const EXAMPLES = [
  'Cancel my Meshy subscription',
  'Book the 08:00 LNER to Edinburgh on Friday, window seat',
  'Download my Hetzner invoices for September',
  'Fix the failing CI on vecgra and open a PR',
];

export function EmptyState() {
  const s = useStore();
  const { resolved } = useTheme();
  const machines = Object.values(s.machines);
  const online = machines.filter((m) => m.status === 'online' || m.status === 'busy').length;
  return (
    <section className="focus empty" aria-label="No runs yet">
      <div className="empty-in">
        <div className="mk">
          <Dither w={22} h={22} shape="orbit" color="--agent" bg="--raised" animate theme={resolved} />
          <div><h2>Nothing running yet</h2><small>{online ? `${online} ${online === 1 ? 'machine is' : 'machines are'} awake and ready` : machines.length ? 'Machines are asleep; one wakes when a run starts' : 'No machines connected yet'}</small></div>
        </div>
        <p>Tell Familiar what you want done, here or on Telegram. It picks a machine, works in a real browser and terminal you can watch live, and asks before spending more than {gbp(s.settings.approval_threshold_p, { short: true })}.</p>
        <div className="composer-wrap" style={{ marginTop: 16 }}>
          <Composer big autoFocus placeholder="e.g. Cancel my Meshy subscription" />
          <div className="chips">
            {EXAMPLES.map((e) => <button key={e} className="chip" onClick={() => window.dispatchEvent(new CustomEvent('familiar:compose', { detail: e }))}>{e}</button>)}
          </div>
        </div>
        <div className="how">
          <div><b><ITelegram />Message it anywhere</b>The web chat and your Telegram bot are one conversation.</div>
          <div><b><IBrowser />Watch every step</b>Live browser, terminal, keyframes and an action log you can rewind.</div>
          <div><b><IHand />Take over any time</b>Press T to pause the agent and drive the machine yourself.</div>
        </div>
        {!machines.length && <p style={{ marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>No machine has dialled in yet. <a href="#" onClick={(e) => { e.preventDefault(); openOverlay('machines'); }}>Start one</a>, or run agentd on any box.</p>}
      </div>
    </section>
  );
}
