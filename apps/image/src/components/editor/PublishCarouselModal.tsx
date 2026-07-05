import { useState, useEffect } from 'react';
import { Send, X, Loader2, Check } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useUIStore } from '../../stores/ui-store';
import { exportArtboard } from '../../services/export-service';
import { getVoidspaceIdToken, NotSignedInError } from '../../services/voidspace-storage';
import { uploadReferenceImage } from '../../services/generative-fill';
import { sizeToAspectRatio } from '../../services/image-generation';

// Platforms the user can target. Voidspace is always available; the others
// require a connected account (the publish preflight silently drops any that
// aren't connected).
const PLATFORMS: { id: string; label: string }[] = [
  { id: 'voidspace', label: 'Voidspace' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'x', label: 'X' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
];

// Extract the Firebase uid from an ID token (the draft store needs user_id in
// the body; the server also verifies the token).
function uidFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.user_id || payload.sub || payload.uid || null;
  } catch {
    return null;
  }
}

/**
 * Publish the project's pages as a social carousel. Renders each page → uploads
 * to a public URL → writes the SAME `social_post_drafts` carousel draft the AI
 * agent writes (via /api/studio/social-draft), so it lands in Pending Approvals
 * (visible on Flutter + web). "Publish now" also fires /api/studio/publish for
 * immediate multi-platform + Voidspace-feed posting.
 */
export function PublishCarouselModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const project = useProjectStore((s) => s.project);
  const showNotification = useUIStore((s) => s.showNotification);

  const pages = project?.artboards ?? [];
  const isCarousel = pages.length > 1;

  const [caption, setCaption] = useState('');
  const [hashtags, setHashtags] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set(['voidspace']));
  const [publishNow, setPublishNow] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (open && project) setCaption((c) => c || project.name || '');
  }, [open, project]);

  // Render small page thumbnails for the preview strip.
  useEffect(() => {
    if (!open || !project) return;
    let cancelled = false;
    (async () => {
      const out: string[] = [];
      for (const ab of project.artboards) {
        try {
          const scale = Math.min(1, 220 / Math.max(ab.size.width, ab.size.height));
          const blob = await exportArtboard(project, ab, { scale, format: 'jpg', quality: 'low', background: 'include' });
          if (cancelled) return;
          out.push(URL.createObjectURL(blob));
          setThumbs([...out]);
        } catch { /* skip a page that won't render */ }
      }
    })();
    return () => { cancelled = true; };
  }, [open, project]);

  if (!open || !project) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      if (next.size === 0) next.add('voidspace');
      return next;
    });
  };

  const publish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = await getVoidspaceIdToken();
      if (!token) throw new NotSignedInError();
      const uid = uidFromToken(token);
      if (!uid) throw new NotSignedInError();

      // Render + upload each page to a public URL.
      const urls: string[] = [];
      for (let i = 0; i < pages.length; i++) {
        setProgress(`Uploading page ${i + 1} of ${pages.length}…`);
        const blob = await exportArtboard(project, pages[i], { scale: 1, format: 'jpg', quality: 'high', background: 'include' });
        const file = new File([blob], `slide-${i + 1}.jpg`, { type: 'image/jpeg' });
        urls.push(await uploadReferenceImage(file));
      }

      setProgress(publishNow ? 'Publishing…' : 'Saving draft…');
      const tags = hashtags.split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
      const tagLine = tags.length ? `\n\n${tags.map((t) => `#${t}`).join(' ')}` : '';
      const platforms = Array.from(selected);
      const draftId = `imgedit-carousel-${Date.now()}`;
      const aspect = sizeToAspectRatio(pages[0].size.width, pages[0].size.height, ['1:1', '4:5', '9:16', '16:9', '4:3', '3:4']);

      const body: Record<string, unknown> = {
        user_id: uid,
        draft_id: draftId,
        avatar_name: 'You',
        platforms,
        content_type: isCarousel ? 'carousel' : 'image',
        title: '',
        content: `${caption.trim()}${tagLine}`.trim(),
        description: caption.trim(),
        image_url: urls[0],
        image_urls: urls,
        aspect_ratio: aspect,
        scene_count: urls.length,
        hashtags: tags,
        project_id: draftId,
        // Publish-now skips the phone approval nudge (the user is shipping from
        // the desktop right now); draft-only emits the Pending Approvals card.
        ...(publishNow ? { source: 'studio_publish_now' } : {}),
      };

      const res = await fetch('/api/studio/social-draft', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`draft failed (${res.status})`);

      if (publishNow) {
        const pubRes = await fetch('/api/studio/publish', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: uid, draft_id: draftId, decision: 'publish', selected_platforms: platforms }),
        });
        if (!pubRes.ok) throw new Error(`publish failed (${pubRes.status})`);
      }

      setDone(true);
      showNotification('success', publishNow ? 'Carousel published' : 'Carousel saved to Pending Approvals');
      setTimeout(() => { setDone(false); onClose(); }, 1200);
    } catch (e) {
      if (e instanceof NotSignedInError) setError('Sign in to Voidspace to publish.');
      else setError("Couldn't publish. Please try again.");
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4" onClick={() => !busy && onClose()}>
      <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-border sticky top-0 bg-card z-10">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <Send size={16} className="text-primary" /> {isCarousel ? `Publish carousel · ${pages.length} pages` : 'Publish post'}
          </span>
          <button onClick={() => !busy && onClose()} className="text-muted-foreground hover:text-foreground" title="Close"><X size={16} /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Page preview strip */}
          <div className="flex gap-2 overflow-x-auto pb-1">
            {(thumbs.length ? thumbs : pages).map((t, i) => (
              <div key={i} className="relative shrink-0 rounded-lg border border-border overflow-hidden bg-muted" style={{ width: 72, height: 90 }}>
                {typeof t === 'string' ? <img src={t} alt="" className="w-full h-full object-cover" /> : null}
                <span className="absolute bottom-0.5 left-0.5 px-1 rounded bg-black/60 text-white text-[9px]">{i + 1}</span>
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Caption</label>
            <textarea value={caption} onChange={(e) => setCaption(e.target.value)} rows={3}
              placeholder="Write a caption…"
              className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg resize-none focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Hashtags</label>
            <input value={hashtags} onChange={(e) => setHashtags(e.target.value)}
              placeholder="design, ai, carousel"
              className="w-full px-3 py-2 text-sm bg-background border border-input rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium text-muted-foreground">Post to</label>
            <div className="flex flex-wrap gap-1.5">
              {PLATFORMS.map((p) => (
                <button key={p.id} onClick={() => toggle(p.id)}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                    selected.has(p.id) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input text-muted-foreground hover:text-foreground'
                  }`}>
                  {p.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">External platforms need a connected account; unconnected ones are skipped.</p>
          </div>

          <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer">
            <input type="checkbox" checked={publishNow} onChange={(e) => setPublishNow(e.target.checked)} className="accent-primary" />
            Publish now (otherwise it's saved to Pending Approvals for review)
          </label>

          {error && <p className="text-[11px] text-destructive">{error}</p>}

          <button onClick={publish} disabled={busy || done || !caption.trim()}
            className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 text-sm rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
            {done ? <><Check size={15} /> Done</> : busy ? <><Loader2 size={15} className="animate-spin" /> {progress || 'Working…'}</> : <><Send size={15} /> {publishNow ? 'Publish now' : 'Save to approvals'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}
