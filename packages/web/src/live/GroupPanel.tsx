import { useState } from 'react'
import {
  colorForId,
  fmtDistance,
  groupSpread,
  haversine,
  type LiveMember,
} from '@bike-travel/shared'
import type { AuthState } from '../storage'
import type { LiveStatus } from './liveClient'

interface Props {
  auth: AuthState | null
  status: LiveStatus
  members: LiveMember[] // 含本人（self=true）
  selfId: string
  room: string
  msg: string
  onRoomChange: (r: string) => void
  onJoin: () => void
  onLeave: () => void
  onFocusMate: (m: LiveMember) => void
  onGotoCloud: () => void
}

const STATUS_LABEL: Record<LiveStatus, { text: string; color: string }> = {
  idle: { text: '未连接', color: '#888' },
  connecting: { text: '连接中…', color: '#F5A623' },
  open: { text: '已连接', color: '#2c7a2c' },
  closed: { text: '已断开', color: '#b04a1e' },
}

function ago(t: number): string {
  if (!t) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 5) return '刚刚'
  if (s < 60) return `${s}秒前`
  return `${Math.floor(s / 60)}分前`
}

export function GroupPanel({
  auth,
  status,
  members,
  selfId,
  room,
  msg,
  onRoomChange,
  onJoin,
  onLeave,
  onFocusMate,
  onGotoCloud,
}: Props) {
  const [draft, setDraft] = useState(room)
  const connected = status === 'open' || status === 'connecting'
  const self = members.find((m) => m.id === selfId)
  const spread = groupSpread(members)
  const st = STATUS_LABEL[status]

  return (
    <div style={card} data-testid="group-panel">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>👥 结伴骑行</div>

      {!auth && (
        <div style={{ fontSize: 12, color: '#555', lineHeight: 1.8 }}>
          结伴功能需要登录以标识身份。
          <button onClick={onGotoCloud} style={linkBtn}>
            去登录 →
          </button>
        </div>
      )}

      {auth && (
        <>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 8, lineHeight: 1.7 }}>
            输入同一房间号，队友的实时位置会显示在地图上。以 <b>{auth.user.name}</b> 的身份加入。
          </div>

          <div style={{ display: 'flex', gap: 6 }}>
            <input
              data-testid="group-room"
              value={draft}
              placeholder="房间号，如 sh-weekend"
              disabled={connected}
              onChange={(e) => {
                setDraft(e.target.value)
                onRoomChange(e.target.value)
              }}
              onKeyDown={(e) => e.key === 'Enter' && !connected && onJoin()}
              style={{ flex: 1, fontSize: 13, padding: '4px 6px' }}
            />
            {!connected ? (
              <button data-testid="group-join" onClick={onJoin}>
                加入
              </button>
            ) : (
              <button data-testid="group-leave" onClick={onLeave} style={{ background: '#d64545', color: '#fff' }}>
                离开
              </button>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 }}>
            <span
              style={{ width: 8, height: 8, borderRadius: 4, background: st.color, display: 'inline-block' }}
            />
            <span data-testid="group-status" style={{ color: st.color }}>
              {st.text}
            </span>
            {connected && (
              <span style={{ color: '#888' }}>
                · 房间 <b>{room}</b> · {spread.count} 人在线
              </span>
            )}
          </div>

          {connected && spread.count >= 2 && (
            <div style={{ fontSize: 12, color: '#555', marginTop: 6, lineHeight: 1.8 }} data-testid="group-spread">
              队伍跨度 <b>{fmtDistance(spread.maxPairM)}</b>
              {spread.laggards.length > 0 && (
                <span style={{ color: '#b04a1e' }}>
                  {' '}
                  · ⚠️ {spread.laggards.length} 人掉队（距队伍中心 &gt; 300m）
                </span>
              )}
            </div>
          )}

          <div style={{ marginTop: 10 }} data-testid="group-members">
            {members.length === 0 && (
              <div style={{ fontSize: 12, color: '#999' }}>
                {connected ? '等待队友加入…' : '加入房间后显示队友'}
              </div>
            )}
            {members.map((m) => {
              const isSelf = m.id === selfId
              const dist =
                !isSelf && m.pos && self?.pos
                  ? haversine(
                      { lng: self.pos.lng, lat: self.pos.lat },
                      { lng: m.pos.lng, lat: m.pos.lat },
                    )
                  : null
              const lag = spread.laggards.includes(m.id)
              return (
                <div
                  key={m.id}
                  data-testid={`group-member-${m.id}`}
                  onClick={() => !isSelf && m.pos && onFocusMate(m)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '6px 6px',
                    borderRadius: 8,
                    cursor: !isSelf && m.pos ? 'pointer' : 'default',
                    background: isSelf ? '#F2F7FC' : 'transparent',
                  }}
                >
                  <span
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: 6,
                      background: m.color || colorForId(m.id),
                      flexShrink: 0,
                      boxShadow: '0 0 0 2px #fff, 0 0 0 3px rgba(0,0,0,.12)',
                    }}
                  />
                  <span style={{ flex: 1, fontSize: 13, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name}
                    {isSelf && <span style={{ color: '#185FA5', fontSize: 11 }}> （我）</span>}
                    {lag && <span style={{ color: '#b04a1e', fontSize: 11 }}> 掉队</span>}
                  </span>
                  <span style={{ fontSize: 11, color: '#999', flexShrink: 0 }}>
                    {isSelf ? '' : dist != null ? fmtDistance(dist) : m.pos ? '' : '定位中'}
                    {m.pos ? ` · ${ago(m.pos.t)}` : ''}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      <div
        data-testid="group-msg"
        style={{ marginTop: 8, fontSize: 12, minHeight: 16, color: msg.startsWith('✅') ? '#2c7a2c' : '#b04a1e' }}
      >
        {msg}
      </div>
    </div>
  )
}

const card: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  left: 12,
  zIndex: 2,
  background: '#fff',
  padding: 14,
  borderRadius: 10,
  width: 276,
  maxHeight: '84%',
  overflow: 'auto',
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const linkBtn: React.CSSProperties = {
  border: 'none',
  background: 'none',
  color: '#185FA5',
  cursor: 'pointer',
  padding: 0,
  fontSize: 12,
  marginLeft: 4,
}
