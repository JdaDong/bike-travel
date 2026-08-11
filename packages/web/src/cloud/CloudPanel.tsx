import { useState } from 'react'
import type { AuthState } from '../storage'

interface Props {
  auth: AuthState | null
  localTracks: number
  cloudTracks: number | null // null = 尚未与云端通信过
  lastSyncAt: number
  syncing: boolean
  msg: string
  onLogin: (name: string, password: string) => void
  onRegister: (name: string, password: string) => void
  onLogout: () => void
  onSyncNow: () => void
}

function fmtTime(ts: number): string {
  if (!ts) return '从未同步'
  const d = new Date(ts)
  const today = new Date().toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return today ? `今天 ${hm}` : `${d.toLocaleDateString('zh-CN')} ${hm}`
}

export function CloudPanel({
  auth,
  localTracks,
  cloudTracks,
  lastSyncAt,
  syncing,
  msg,
  onLogin,
  onRegister,
  onLogout,
  onSyncNow,
}: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')

  const submit = () => {
    if (!name.trim() || !password) return
    if (mode === 'login') onLogin(name.trim(), password)
    else onRegister(name.trim(), password)
  }

  return (
    <div style={card} data-testid="cloud-panel">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>☁️ 云同步</div>

      {!auth && (
        <>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
            登录后，骑行档案与旅游行程会自动同步到服务器，换设备继续用。
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button onClick={() => setMode('login')} style={mode === 'login' ? chipOn : chipOff}>
              登录
            </button>
            <button onClick={() => setMode('register')} style={mode === 'register' ? chipOn : chipOff}>
              注册
            </button>
          </div>
          <input
            data-testid="cloud-name"
            value={name}
            placeholder="用户名"
            onChange={(e) => setName(e.target.value)}
            style={input}
          />
          <input
            data-testid="cloud-pass"
            value={password}
            type="password"
            placeholder="密码（至少 6 位）"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            style={input}
          />
          <button
            data-testid="cloud-submit"
            onClick={submit}
            disabled={syncing}
            style={{ width: '100%', marginTop: 8 }}
          >
            {syncing ? '处理中…' : mode === 'login' ? '登录并同步' : '注册并同步'}
          </button>
        </>
      )}

      {auth && (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            已登录：<b data-testid="cloud-user">{auth.user.name}</b>
          </div>
          <div style={{ fontSize: 12, color: '#555', lineHeight: 1.9 }} data-testid="cloud-counts">
            <div>
              本地轨迹：<b>{localTracks}</b> 条
            </div>
            <div>
              云端轨迹：<b>{cloudTracks === null ? '—' : cloudTracks}</b> 条
            </div>
            <div>上次同步：{fmtTime(lastSyncAt)}</div>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
            <button data-testid="cloud-sync" onClick={onSyncNow} disabled={syncing} style={{ flex: 1 }}>
              {syncing ? '同步中…' : '⟳ 立即同步'}
            </button>
            <button data-testid="cloud-logout" onClick={onLogout} disabled={syncing}>
              退出
            </button>
          </div>
          <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
            数据变更后会自动同步。轨迹按并集合并，删除会跨设备生效；行程以最后修改的一版为准。
          </p>
        </>
      )}

      <div
        data-testid="cloud-status"
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
  width: 260,
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const input: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 13,
  padding: '4px 6px',
  marginTop: 6,
}

const chipOn: React.CSSProperties = {
  padding: '2px 10px',
  borderRadius: 12,
  border: '1px solid #185FA5',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}

const chipOff: React.CSSProperties = {
  padding: '2px 10px',
  borderRadius: 12,
  border: '1px solid #ccc',
  background: '#f5f5f5',
  cursor: 'pointer',
  fontSize: 12,
}
