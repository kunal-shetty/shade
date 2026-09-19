import { useSettings } from '../store/settings';
import type { Incident, MqttDeviceHealth, RoverStatus, SensorReading } from '../types';

export interface ApiConfig {
  base: string;
}

export const getApiBase = (): string => {
  const { host, apiPort } = useSettings.getState().connection;
  return `http://${host}:${apiPort}`;
};

export const getStreamUri = (): string => {
  const { host, streamPort, demoMode } = useSettings.getState().connection;
  if (demoMode) {
    // Inline MJPEG-over-HTML demo stream rendered in a WebView (no hardware needed)
    return demoStreamHtmlUri();
  }
  return `http://${host}:${streamPort}`;
};

const DEMO_HTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>html,body{margin:0;height:100%;background:#0b1220;overflow:hidden}
canvas{display:block;width:100vw;height:100vh}</style></head>
<body><canvas id="c"></canvas><script>
const c=document.getElementById('c'),x=c.getContext('2d');
function fit(){c.width=innerWidth*devicePixelRatio;c.height=innerHeight*devicePixelRatio}
addEventListener('resize',fit);fit();
let t=0,noise=[];
for(let i=0;i<400;i++)noise.push({x:Math.random(),y:Math.random(),s:Math.random()});
function draw(){
 t+=0.016;
 const w=c.width,h=c.height;
 const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,'#0e1a2e');g.addColorStop(1,'#0b1220');
 x.fillStyle=g;x.fillRect(0,0,w,h);
 x.strokeStyle='rgba(148,163,184,0.10)';x.lineWidth=1;
 for(let i=0;i<12;i++){const gx=(i/12)*w;x.beginPath();x.moveTo(gx,0);x.lineTo(gx,h);x.stroke()}
 for(let i=0;i<8;i++){const gy=(i/8)*h;x.beginPath();x.moveTo(0,gy);x.lineTo(w,gy);x.stroke()}
 x.strokeStyle='rgba(14,165,233,0.35)';x.lineWidth=2;
 x.beginPath();x.moveTo(w*0.08,h*0.85);x.lineTo(w*0.35,h*0.55);x.lineTo(w*0.62,h*0.62);x.lineTo(w*0.9,h*0.3);x.stroke();
 const px=w*(0.55+0.06*Math.sin(t*0.7)),py=h*(0.42+0.05*Math.cos(t*0.9)),pw=w*0.09,ph=h*0.26;
 x.fillStyle='#94a3b8';
 x.beginPath();x.arc(px,py-ph*0.82,ph*0.14,0,7);x.fill();
 x.beginPath();x.ellipse(px,py-ph*0.25,ph*0.2,ph*0.38,0,0,7);x.fill();
 x.strokeStyle='#0EA5E9';x.lineWidth=3;x.setLineDash([10,8]);
 x.strokeRect(px-pw/2,py-ph*1.05,pw,ph*1.15);x.setLineDash([]);
 x.fillStyle='#0EA5E9';x.font=\`\${Math.round(h*0.028)}px monospace\`;
 x.fillText('PERSON 0.94',px-pw/2,py-ph*1.12);
 for(const n of noise){x.fillStyle=\`rgba(226,232,240,\${0.04+0.05*n.s})\`;
  x.fillRect(n.x*w,n.y*h,2,2)}
 x.fillStyle='rgba(226,232,240,0.85)';x.font=\`\${Math.round(h*0.03)}px monospace\`;
 x.fillText(new Date().toLocaleTimeString(),16,h*0.06);
 x.fillStyle='rgba(14,165,233,0.9)';
 x.fillText('DEMO STREAM \u2022 640x480 \u2022 20fps',16,h*0.11);
 requestAnimationFrame(draw)}
draw();
</script></body></html>`;

let demoUriCache: string | null = null;
const demoStreamHtmlUri = (): string => {
  if (!demoUriCache) {
    demoUriCache = `data:text/html;base64,${btoa(unescape(encodeURIComponent(DEMO_HTML)))}`;
  }
  return demoUriCache;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`API ${res.status} on ${path}`);
  return (res.json() as Promise<T>);
}

export const api = {
  health: () => request<{ status: string }>('/health'),
  listIncidents: (params: { limit?: number; offset?: number; severity?: string; resolved?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.severity) q.set('severity', params.severity);
    if (params.resolved != null) q.set('resolved', String(params.resolved));
    const qs = q.toString();
    return request<Incident[]>(`/incidents${qs ? `?${qs}` : ''}`);
  },
  getIncident: (id: number) => request<Incident>(`/incidents/${id}`),
  patchIncident: (id: number, body: { resolution_notes?: string; resolved?: boolean }) =>
    request<Incident>(`/incidents/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  sensorsLatest: () => request<Record<string, SensorReading>>('/sensors/latest'),
  roverStatus: () => request<RoverStatus>('/rover/status'),
  triggerAlarm: () => request<{ ok: boolean }>('/alarm/trigger', { method: 'POST' }),
  resetAlarm: () => request<{ ok: boolean }>('/alarm/reset', { method: 'POST' }),
  cameraRecord: () => request<{ ok: boolean }>('/camera/record', { method: 'POST' }),
  cameraNightMode: () => request<{ ok: boolean }>('/camera/nightmode', { method: 'POST' }),
  deviceHealth: () => request<MqttDeviceHealth>('/health'),
  fcmRegister: (token: string) =>
    request<{ ok: boolean }>('/fcm/register', { method: 'POST', body: JSON.stringify({ token }) }),
};
