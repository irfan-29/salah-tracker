import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import Loader from '../components/Loader';

// The Kaaba's coordinates - every Qibla bearing is the initial great-circle
// bearing from the reader's spot to this point.
const KAABA = { lat: 21.4224779, lng: 39.8261837 };

// The prayer-time locations the app already offers, so the compass can fall
// back to the reader's saved city when the browser keeps its GPS to itself.
const FALLBACK_COORDS = {
  Coimbatore: { lat: 11.0018, lng: 76.9628 },
  Hosur: { lat: 12.7369, lng: 77.6837 },
  Salem: { lat: 11.6643, lng: 78.1462 },
  Ramanathapuram: { lat: 9.3639, lng: 78.8392 },
  Bengaluru: { lat: 12.9716, lng: 77.5946 },
};

const rad = (deg) => (deg * Math.PI) / 180;
const normalize = (deg) => ((deg % 360) + 360) % 360;

// Initial bearing on the great circle from (lat, lng) to the Kaaba.
function qiblaFrom(lat, lng) {
  const f1 = rad(lat);
  const f2 = rad(KAABA.lat);
  const dl = rad(KAABA.lng - lng);
  const y = Math.sin(dl);
  const x = Math.cos(f1) * Math.tan(f2) - Math.sin(f1) * Math.cos(dl);
  return normalize((Math.atan2(y, x) * 180) / Math.PI);
}

function distanceToKaaba(lat, lng) {
  const f1 = rad(lat);
  const f2 = rad(KAABA.lat);
  const df = rad(KAABA.lat - lat);
  const dl = rad(KAABA.lng - lng);
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// A real compass rose: 72 ticks, the principal eight longer.
const TICKS = Array.from({ length: 72 }, (_, i) => i * 5);
const CARDINALS = [
  { label: 'N', deg: 0 },
  { label: 'E', deg: 90 },
  { label: 'S', deg: 180 },
  { label: 'W', deg: 270 },
];

export default function QiblaPage() {
  const [state, setState] = useState({ status: 'locating' });
  const [heading, setHeading] = useState(0);
  const [live, setLive] = useState(false);
  const [note, setNote] = useState('');
  // Tracks when the absolute event last fired so the generic handler can step
  // aside instead of double-applying a different convention to the heading.
  const lastAbsolute = useRef(0);

  const locate = useCallback(async () => {
    setState({ status: 'locating' });
    const apply = (lat, lng, source) => setState({
      status: 'ready',
      lat,
      lng,
      source,
      bearing: qiblaFrom(lat, lng),
      distanceKm: distanceToKaaba(lat, lng),
    });
    // GPS first: the bearing is only as good as the coordinate it starts from.
    try {
      const pos = await new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('no geolocation'));
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 8000, maximumAge: 600000 });
      });
      return apply(pos.coords.latitude, pos.coords.longitude, 'gps');
    } catch { /* fall through to the reader's saved city */ }
    try {
      const data = await api.get('/salah-timings');
      const coords = FALLBACK_COORDS[data.location];
      if (coords) return apply(coords.lat, coords.lng, 'saved');
    } catch { /* and finally the app's default city */ }
    apply(FALLBACK_COORDS.Coimbatore.lat, FALLBACK_COORDS.Coimbatore.lng, 'default');
  }, []);

  useEffect(() => { locate(); }, [locate]);

  // Android exposes absolute orientation; iOS only the webkitCompassHeading
  // flavour. Both land on the same heading number: degrees clockwise from
  // true north that the top of the phone is facing.
  const onOrientation = useCallback((event) => {
    let h = null;
    if (event.absolute && event.alpha != null) {
      h = 360 - event.alpha;
      lastAbsolute.current = Date.now();
    } else if (event.webkitCompassHeading != null) {
      h = event.webkitCompassHeading;
    } else if (Date.now() - lastAbsolute.current > 1500 && event.alpha != null) {
      h = 360 - event.alpha;
    }
    if (h != null && !Number.isNaN(h)) setHeading(normalize(h));
  }, []);

  useEffect(() => () => {
    window.removeEventListener('deviceorientationabsolute', onOrientation);
    window.removeEventListener('deviceorientation', onOrientation);
  }, [onOrientation]);

  async function enableCompass() {
    try {
      // iOS gates the sensor behind a user gesture - this button is it.
      if (window.DeviceOrientationEvent?.requestPermission) {
        const res = await window.DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          setNote('Compass permission was declined. Allow motion access for this site in your browser settings - until then the dial keeps north up.');
          return;
        }
      }
      window.addEventListener('deviceorientationabsolute', onOrientation);
      window.addEventListener('deviceorientation', onOrientation);
      setLive(true);
      setNote('');
    } catch {
      setNote('This device has no compass - the dial keeps north up.');
    }
  }

  const ready = state.status === 'ready';
  // Within ~4 degrees of dead-on the needle lights up: put the phone flat,
  // turn until the Kaaba mark glows, and that edge is the Qibla.
  const aligned = ready && live && Math.abs(normalize(state.bearing - heading + 180) - 180) < 4;
  const sourceNote = state.source === 'gps'
    ? 'Using your current location'
    : state.source === 'saved' ? 'Approximate - using your saved city' : 'Approximate - using the default city';
  const onPhone = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;

  return (
    <>
      <div className="page-header">
        <h1>Qibla Direction</h1>
      </div>
      {state.status === 'locating' && (
        <div className="qibla-card">
          <Loader variant="inline" label="Finding your location" />
        </div>
      )}
      {ready && (
        <div className="qibla-card">
          <div className="qibla-compass">
            <div className={`qibla-dial${aligned ? ' is-aligned' : ''}`} style={{ transform: `rotate(${-heading}deg)` }}>
              {TICKS.map((deg) => (
                <span
                  key={deg}
                  className={`qibla-tick${deg % 45 === 0 ? ' is-major' : ''}`}
                  style={{ transform: `rotate(${deg}deg)` }}
                  aria-hidden="true"
                />
              ))}
              {CARDINALS.map((c) => (
                <span
                  key={c.label}
                  className={`qibla-cardinal${c.label === 'N' ? ' is-north' : ''}`}
                  style={{ transform: `rotate(${c.deg}deg) translateY(-29%)` }}
                  aria-hidden="true"
                >
                  {c.label}
                </span>
              ))}
              <span
                className={`qibla-needle${aligned ? ' is-aligned' : ''}`}
                style={{ transform: `rotate(${state.bearing}deg)` }}
                aria-hidden="true"
              >
                <span className="qibla-kaaba" />
              </span>
            </div>
            <div className="qibla-hub" aria-hidden="true" />
          </div>
          <div className="qibla-readout">
            <div className="qibla-bearing">
              {Math.round(state.bearing)}
              <span className="qibla-degree">&deg;</span>
            </div>
            <div className="qibla-meta">
              from true north &middot; {Math.round(state.distanceKm).toLocaleString()} km to the Kaaba
            </div>
            <div className="qibla-source">{sourceNote}</div>
          </div>
          {!live && onPhone && (
            <button type="button" className="btn qibla-compass-btn" onClick={enableCompass}>
              Enable live compass
            </button>
          )}
          {live && (
            <p className={`qibla-note${aligned ? ' is-aligned' : ''}`}>
              {aligned
                ? 'Facing the Kaaba mark - this edge is the Qibla.'
                : 'Hold the phone flat and turn slowly until the mark glows.'}
            </p>
          )}
          {note && <p className="qibla-note">{note}</p>}
        </div>
      )}
    </>
  );
}
