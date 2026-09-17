import type { CSSProperties } from 'react';
export function Icon({name,size=20,style}:{name:string;size?:number;style?:CSSProperties}) {
  const paths:Record<string,React.ReactNode>={
    studio:<><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7m-3.5-3.5v7"/></>,
    activity:<><path d="M3 12h4l3-8 4 16 3-8h4"/></>,
    settings:<><path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="9" r="2"/><circle cx="12" cy="16" r="2"/><circle cx="19" cy="8" r="2"/></>,
    arrow:<path d="M4 12h15m-6-6 6 6-6 6"/>,external:<><path d="M14 3h7v7m0-7L10 14"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></>,
    globe:<><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/></>,
    upload:<><path d="M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    code:<><path d="m7 5-6 7 6 7m10-14 6 7-6 7m-4-16-2 18"/></>,
    check:<path d="m5 12 4 4L19 6"/>,close:<path d="m6 6 12 12M6 18 18 6"/>,plus:<path d="M12 4v16M4 12h16"/>,
    menu:<path d="M4 6h16M4 12h16M4 18h16"/>,chevron:<path d="m9 5 7 7-7 7"/>,
    refresh:<><path d="M20 6v5h-5M4 18v-5h5"/><path d="M5.7 7A7 7 0 0 1 18 6l2 5M4 13l2 5a7 7 0 0 0 12.3-1"/></>,
    monitor:<><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
    tablet:<><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M11 19h2"/></>,
    mobile:<><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 19h2"/></>,
    shield:<><path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6z"/><path d="m8 12 3 3 5-6"/></>,
    key:<><circle cx="8" cy="8" r="5"/><path d="m12 12 9 9m-4-4 3-3m-6 0 3-3"/></>,
    book:<><path d="M12 5v16M3 3h5a4 4 0 0 1 4 2 4 4 0 0 1 4-2h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3z"/></>,
    clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    folder:<path d="M3 7V5h7l2 2h9v13H3z"/>,
    info:<><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/></>,
    download:<><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    github:<><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-4a3.5 3.5 0 0 0-1-3c3-.4 6-1.5 6-6a4.7 4.7 0 0 0-1.3-3.3A4.3 4.3 0 0 0 19.6 2S18.5 1.7 16 3a11 11 0 0 0-6 0C7.5 1.7 6.4 2 6.4 2a4.3 4.3 0 0 0-.1 3.7A4.7 4.7 0 0 0 5 9c0 4.5 3 5.6 6 6a3.5 3.5 0 0 0-1 3v4"/></>,
    layers:<><path d="m12 3 10 5-10 5L2 8zm-9 9 9 5 9-5m-18 5 9 5 9-5"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]??paths.info}</svg>;
}
export function Mark(){return <svg className="mark" width="36" height="36" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="currentColor"/><path d="M14 45V22l9-5 9 17 9-17 9 5v23H39V31l-7 13-7-13v14z" fill="#101210"/></svg>;}
