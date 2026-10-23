import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { posts as api } from '../services/api';
import { useSession } from '../hooks/useSession';
import Loader from '../components/Loader';
import NotFound from './NotFound';

// Reuses views/post-card.ejs's markup, which the shared stylesheet already
// styles. The card is factored out because the feed, a profile and a permalink
// all render it, and three copies is how they drift.
export function PostCard({ post, permalinkBase = '', canManage, onChanged, onDeleted }) {
  const { username } = useSession();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');

  // Profile responses do not populate `author` (every post there belongs to the
  // profile owner), so that page passes an explicit canManage. Everywhere else
  // the post carries its populated author.
  const owned = canManage !== undefined
    ? canManage
    : Boolean(username && post.author && post.author.username === username);

  const handle = post.author && post.author.username ? post.author.username : null;
  const permalink = permalinkBase + '/post/' + post._id;

  async function handleDelete() {
    if (deleting) return;
    if (!window.confirm('Delete this post? This cannot be undone.')) return;

    setDeleting(true);
    setError('');
    try {
      await api.remove(post._id);
      setRemoved(true);
      if (onDeleted) onDeleted(post);
    } catch (err) {
      setError(err.status === 401 ? 'Sign in to delete this post.' : 'Could not delete that post.');
      setDeleting(false);
    }
  }

  if (removed) return null;

  if (editing) {
    return (
      <PostForm
        post={post}
        onClose={() => setEditing(false)}
        onSaved={(updated) => {
          setEditing(false);
          if (onChanged) onChanged(updated);
        }}
      />
    );
  }

  const date = (
    <p className="post-date">
      <Link className="post-permalink" to={`/post/${post._id}`}>{post.postedDate}</Link>
    </p>
  );

  return (
    <div className={`post-card${post.isVideo ? ' post-card-video' : ''}`}>
      <div className="post-card-head">
        {handle ? (
          <Link className="post-author" to={`/u/${handle}`}>
            <span className="post-author-avatar" aria-hidden="true">{handle.charAt(0).toUpperCase()}</span>
            <span className="post-author-name">{handle}</span>
          </Link>
        ) : post.authorName ? (
          <span className="post-author post-author-anonymous">{post.authorName}</span>
        ) : null}

        <div className="post-card-actions">
          {owned && (
            <>
              <button type="button" className="post-share" onClick={() => setEditing(true)}
                      title="Edit post" aria-label="Edit post">
                <span className="material-symbols-rounded">edit</span>
              </button>
              <button type="button" className="post-share post-share-danger" onClick={handleDelete}
                      disabled={deleting} title="Delete post" aria-label="Delete post">
                <span className="material-symbols-rounded">{deleting ? 'hourglass_top' : 'delete'}</span>
              </button>
            </>
          )}
          <button type="button" className="post-share" data-share-url={permalink}
                  title="Copy link to this post" aria-label="Copy link to this post">
            <span className="material-symbols-rounded">share</span>
          </button>
        </div>
      </div>

      {error && <p className="post-error" role="alert">{error}</p>}

      {post.isVideo ? (
        <>
          <div className="post-video-embed">
            <iframe src={`https://www.youtube.com/embed/${post.content}`} allowFullScreen title="Embedded video" />
          </div>
          {/* The player is edge-to-edge, so the caption sits in the same inset
              the rest of the card uses instead of on the border. */}
          <div className="post-card-body">
            {post.reference && <p className="post-reference">{post.reference}</p>}
            {date}
          </div>
        </>
      ) : (
        <>
          <p className="post-content">{post.content}</p>
          {post.reference && <p className="post-reference">Reference: {post.reference}</p>}
          {date}
        </>
      )}
    </div>
  );
}

export function PostsPage() {
  const [data, setData] = useState({ loading: true, posts: [], permalinkBase: '' });
  const [composing, setComposing] = useState(false);

  const load = useCallback(async () => {
    setData((d) => ({ ...d, loading: true }));
    try {
      const result = await api.list();
      setData({ loading: false, posts: result.posts || [], permalinkBase: result.permalinkBase || '' });
    } catch (err) {
      setData({ loading: false, posts: [], permalinkBase: '' });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <div className="page-header">
        <h1>Posts</h1>
        <p>Reflections, reminders, and videos</p>
      </div>

      <div className="post-actions">
        {/* One entry point. Text or video is chosen inside the form, so the
            page does not carry two buttons that open the same thing. */}
        <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
          <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>add</span>
          Add Post
        </button>
      </div>

      {composing && (
        <PostForm
          onClose={() => setComposing(false)}
          onSaved={async () => { setComposing(false); await load(); }}
        />
      )}

      {data.loading ? <Loader variant="inline" label="Loading posts" /> : data.posts.length === 0 ? (
        <p className="post-empty">No posts yet.</p>
      ) : (
        data.posts.map((post) => (
          <PostCard
            key={post._id}
            post={post}
            permalinkBase={data.permalinkBase}
            onChanged={(updated) => setData((d) => ({
              ...d,
              posts: d.posts.map((p) => (p._id === updated._id ? updated : p)),
            }))}
            onDeleted={(deleted) => setData((d) => ({
              ...d,
              posts: d.posts.filter((p) => p._id !== deleted._id),
            }))}
          />
        ))
      )}
    </>
  );
}

// Seed the edit field with something a person recognises. Stored values are
// bare YouTube ids, but a legacy row may already hold a full URL.
function videoLink(content) {
  const value = String(content || '');
  if (!value) return '';
  return /^https?:\/\//i.test(value) ? value : `https://youtu.be/${value}`;
}

function PostForm({ post, onClose, onSaved }) {
  const editing = Boolean(post);
  const [isVideo, setIsVideo] = useState(post ? Boolean(post.isVideo) : false);
  const [link, setLink] = useState(post && post.isVideo ? videoLink(post.content) : '');
  const [content, setContent] = useState(post && !post.isVideo ? (post.content || '') : '');
  const [reference, setReference] = useState(post ? (post.reference || '') : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Accept the URL forms people actually paste. The stored value is only the
  // id, because the card builds `embed/<id>`; storing a full watch URL would
  // make the player request embed/https://... and fail.
  function extractId(raw) {
    const value = String(raw || '').trim();
    const match = value.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/)
      || value.match(/[?&]v=([A-Za-z0-9_-]{6,})/)
      || value.match(/\/embed\/([A-Za-z0-9_-]{6,})/)
      || value.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
    return match ? match[1] : value;
  }

  const canSave = isVideo ? Boolean(link.trim()) : Boolean(content.trim());

  async function submit() {
    setSaving(true);
    setError('');
    try {
      const payload = {
        content: isVideo ? extractId(link) : content,
        reference,
        isVideo,
      };
      const result = editing ? await api.update(post._id, payload) : await api.create(payload);
      await onSaved(result && result.post);
    } catch (err) {
      if (err.status === 401) setError('Sign in to save this post.');
      else if (err.status === 403) setError('You can only edit your own posts.');
      else setError(editing ? 'Could not save those changes.' : 'Could not save that post.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="container1">
      <div className="card-header">
        <h3>{editing ? (isVideo ? 'Edit Video' : 'Edit Post') : 'New Post'}</h3>
      </div>

      {!editing && (
        <div className="post-compose-types" role="group" aria-label="Post type">
          <button type="button" className={`btn ${isVideo ? 'btn-outline' : 'btn-primary'}`}
                  onClick={() => setIsVideo(false)} aria-pressed={!isVideo}>
            <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>edit_note</span>
            Text
          </button>
          <button type="button" className={`btn ${isVideo ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setIsVideo(true)} aria-pressed={isVideo}>
            <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>videocam</span>
            Video
          </button>
        </div>
      )}

      {isVideo && (
        <div className="form-floating">
          <input className="form-control" type="url" value={link} onChange={(e) => setLink(e.target.value)}
                 placeholder="https://youtu.be/..." />
          <label>Video link</label>
        </div>
      )}

      {!isVideo && (
        <div className="form-floating">
          <textarea className="form-control" rows={4} value={content} onChange={(e) => setContent(e.target.value)}
                    placeholder="Write something…" />
          <label>Content</label>
        </div>
      )}

      <div className="form-floating">
        <input className="form-control" type="text" value={reference} onChange={(e) => setReference(e.target.value)}
               placeholder={isVideo ? 'Description' : 'Reference'} />
        <label>{isVideo ? 'Description' : 'Reference'}</label>
      </div>

      {error && <div className="auth-alert" role="alert"><span className="material-symbols-rounded">error</span>{error}</div>}

      <div className="new-task">
        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || !canSave}>
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Save'}
        </button>
        <button type="button" className="btn btn-outline" style={{ marginLeft: '0.5rem' }} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

export function PostPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [state, setState] = useState({ loading: true, post: null, permalinkBase: '' });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, post: null, permalinkBase: '' });
    api.one(id)
      .then((data) => { if (!cancelled) setState({ loading: false, post: data.post, permalinkBase: data.permalinkBase || '' }); })
      .catch(() => { if (!cancelled) setState({ loading: false, post: null, permalinkBase: '' }); });
    return () => { cancelled = true; };
  }, [id]);

  if (state.loading) return <Loader variant="page" label="Loading post" />;
  if (!state.post) return <NotFound />;

  const post = state.post;
  return (
    <>
      <div className="page-header">
        <h1>Post</h1>
        <p>
          {post.author && post.author.username ? (
            <Link className="post-author" to={`/u/${post.author.username}`}>
              <span className="post-author-avatar" aria-hidden="true">{post.author.username.charAt(0).toUpperCase()}</span>
              <span className="post-author-name">{post.author.username}</span>
            </Link>
          ) : post.authorName ? (
            <span className="post-author post-author-anonymous">{post.authorName}</span>
          ) : null}
        </p>
      </div>

      <PostCard
        post={post}
        permalinkBase={state.permalinkBase}
        onChanged={(updated) => setState((s) => ({ ...s, post: updated }))}
        onDeleted={() => navigate('/posts')}
      />
      <p className="post-back"><Link to="/posts">&larr; Back to all posts</Link></p>
    </>
  );
}

export function ProfilePage() {
  const { username } = useParams();
  const [state, setState] = useState({ loading: true, data: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, data: null });
    api.profile(username)
      .then((data) => { if (!cancelled) setState({ loading: false, data }); })
      .catch(() => { if (!cancelled) setState({ loading: false, data: null }); });
    return () => { cancelled = true; };
  }, [username]);

  if (state.loading) return <Loader variant="page" label="Loading profile" />;
  if (!state.data) return <NotFound />;

  const { owner, posts, permalinkBase, isOwner } = state.data;
  const shareUrl = (permalinkBase || '') + '/u/' + owner.username;

  return (
    <>
      <div className="profile-header">
        <div className="profile-avatar" aria-hidden="true">{owner.username.charAt(0).toUpperCase()}</div>
        <div className="profile-meta">
          <h1 className="profile-handle">{owner.username}</h1>
          <p className="profile-stats">
            <strong>{posts.length}</strong> {posts.length === 1 ? 'post' : 'posts'}
            {isOwner && <span className="profile-badge">This is you</span>}
          </p>
        </div>
        <div className="profile-actions">
          <button type="button" className="btn btn-outline-primary profile-share" data-share-url={shareUrl}>
            <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>share</span>
            Share profile
          </button>
        </div>
      </div>

      {posts.length === 0 ? (
        <p className="post-empty">{isOwner ? 'You have not posted anything yet.' : 'This user has not posted anything yet.'}</p>
      ) : (
        posts.map((post) => (
          <PostCard
            key={post._id}
            post={post}
            permalinkBase={permalinkBase}
            // The profile payload leaves `author` as an id, so ownership comes
            // from the profile-level flag rather than from the post itself.
            canManage={isOwner}
            onChanged={(updated) => setState((s) => (s.data ? {
              ...s,
              data: { ...s.data, posts: s.data.posts.map((p) => (p._id === updated._id ? updated : p)) },
            } : s))}
            onDeleted={(deleted) => setState((s) => (s.data ? {
              ...s,
              data: { ...s.data, posts: s.data.posts.filter((p) => p._id !== deleted._id) },
            } : s))}
          />
        ))
      )}
    </>
  );
}