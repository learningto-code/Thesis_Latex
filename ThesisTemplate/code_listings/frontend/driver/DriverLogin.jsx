import { useState } from 'react';
import { driverLogin } from '../../utils/driverApi';
import { Truck } from 'lucide-react';

export default function DriverLogin({ onLogin }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  function pressDigit(d) {
    if (pin.length < 4) setPin((p) => p + d);
  }
  function backspace() {
    setPin((p) => p.slice(0, -1));
  }

  async function submit() {
    if (pin.length !== 4) return;
    setLoading(true);
    setError('');
    try {
      const data = await driverLogin(pin);
      onLogin(data);
    } catch (e) {
      setError(e.message || 'Login failed');
      setPin('');
    } finally {
      setLoading(false);
    }
  }

  const dots = Array.from({ length: 4 }, (_, i) => (
    <span key={i} style={{ ...styles.dot, background: i < pin.length ? '#82B7DC' : '#1a3460' }} />
  ));

  return (
    <div style={styles.page}>
      <div style={styles.logo}><Truck size={64} /></div>
      <h2 style={styles.title}>Fleet Monitor</h2>
      <p style={styles.subtitle}>Driver Login</p>

      <div style={styles.dotsRow}>{dots}</div>
      {error && <p style={styles.error}>{error}</p>}

      <div style={styles.keypad}>
        {['1','2','3','4','5','6','7','8','9'].map((d) => (
          <button key={d} style={styles.key} disabled={loading} onClick={() => pressDigit(d)}>
            {d}
          </button>
        ))}
        <button style={styles.key} disabled={loading} onClick={backspace}>?</button>
        <button style={styles.key} disabled={loading} onClick={() => pressDigit('0')}>0</button>
        <button
          style={{ ...styles.key, ...styles.loginKey, opacity: pin.length === 4 && !loading ? 1 : 0.45 }}
          disabled={pin.length !== 4 || loading}
          onClick={submit}
        >
          {loading ? '...' : 'LOGIN'}
        </button>
      </div>
    </div>
  );
}

const styles = {
  page: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 24px 32px', minHeight: '100dvh', background: '#0d1f3c', color: '#F7F7F7' },
  logo: { display:'flex', alignItems:'center', justifyContent:'center', color:'#82B7DC' },
  title: { margin: '8px 0 4px', fontSize: 22, fontWeight: 700, color: '#F7F7F7' },
  subtitle: { margin: '0 0 32px', fontSize: 14, color: '#82B7DC' },
  dotsRow: { display: 'flex', gap: 16, marginBottom: 12 },
  dot: { width: 18, height: 18, borderRadius: '50%', transition: 'background 0.15s' },
  error: { color: '#ff6b6b', fontSize: 13, margin: '0 0 8px', textAlign: 'center' },
  keypad: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, width: '100%', maxWidth: 300, margin: '12px 0' },
  key: { padding: '18px 0', fontSize: 22, fontWeight: 600, borderRadius: 12, border: '1px solid #346AA8', background: '#1a3460', color: '#F7F7F7', cursor: 'pointer', touchAction: 'manipulation', boxShadow: '0 2px 12px rgba(0,0,0,0.5)' },
  loginKey: { background: '#346AA8', border: 'none', color: '#F7F7F7', fontSize: 14, fontWeight: 800, letterSpacing: 1 },
};
