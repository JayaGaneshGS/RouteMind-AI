import { useState } from 'react';
import api from '../api';
import { errorMessage } from '../utils';
import { Icon } from './ui';

/**
 * Text field + explicit "search" action (Enter or button). We deliberately do NOT search on every keystroke:
 * the public Nominatim service forbids autocomplete-style traffic.
 * `value` is {text, place|null}; typing clears the resolved place, picking a suggestion sets it.
 */
export default function PlaceInput({ id, label, placeholder, value, onChange }) {
  const [options, setOptions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  async function search() {
    if (value.text.trim().length < 2) return;
    setBusy(true); setMsg(''); setOptions([]);
    try {
      const { data } = await api.get('/locations/search', { params: { q: value.text.trim() } });
      if (!data.results.length) setMsg('No matching place found. Try a different spelling.');
      setOptions(data.results);
    } catch (e) { setMsg(errorMessage(e)); } finally { setBusy(false); }
  }

  return (
    <div className="relative">
      <label htmlFor={id} className="label">{label}</label>
      <div className="flex gap-2">
        <input
          id={id} className="input" placeholder={placeholder} value={value.text} autoComplete="off"
          onChange={(e) => { onChange({ text: e.target.value, place: null }); setOptions([]); setMsg(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }}
        />
        <button type="button" className="btn-secondary px-3" onClick={search} disabled={busy} aria-label={`Search ${label}`} title="Look up this place">
          {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" /> : <Icon name="search" className="h-4 w-4" />}
        </button>
      </div>
      {value.place && <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700"><Icon name="pin" className="h-3.5 w-3.5" />{value.place.name}</p>}
      {msg && <p className="mt-1 text-xs text-red-600">{msg}</p>}
      {options.length > 0 && (
        <ul className="absolute z-[1000] mt-1 max-h-56 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg" role="listbox">
          {options.map((o, i) => (
            <li key={i}>
              <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-brand-50"
                onClick={() => { onChange({ text: o.shortName || o.name, place: o }); setOptions([]); }}>
                {o.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
