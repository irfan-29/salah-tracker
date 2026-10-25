import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { posts as api } from '../services/api';
import { useSession } from '../hooks/useSession';
import Loader from '../components/Loader';
import NotFound from './NotFound';

// Reuses views/post-card.ejs's markup, which the shared stylesheet already
// styles. The card is factored out because the feed, a profile and a permalink
// all render it, and three copies is how they drift.
export function PostCard({ post, permalinkBase = '', canManage, onChanged, onDeleted }) {
  const { username, isLoggedIn } = useSession();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef(null);
  const moreButtonRef = useRef(null);
  const [likeState, setLikeState] = useState({
    liked: Boolean(post.likedByMe),
    count: Number(post.likeCount) || 0,
    busy: false,
  });

  useEffect(() => {
    setLikeState({
      liked: Boolean(post.likedByMe),
      count: Number(post.likeCount) || 0,
      busy: false,
    });
  }, [post._id, post.likedByMe, post.likeCount]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event) => {
      if (!moreRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        moreButtonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Profile responses do not populate `author` (every post there belongs to the
  // profile owner), so that page passes an explicit canManage. Everywhere else
  // the post carries its populated author.
  const owned = canManage !== undefined
    ? canManage
    : Boolean(username && post.author && post.author.username === username);

  const handle = post.author && post.author.username ? post.author.username : null;
  const permalink = permalinkBase + '/post/' + post._id;
  const moreMenuId = `post-more-${post._id}`;

  async function handleLike() {
    if (!isLoggedIn) {
      navigate('/login');
      return;
    }
    if (likeState.busy) return;

    const previous = likeState;
    const liked = !previous.liked;
    const count = Math.max(0, previous.count + (liked ? 1 : -1));
    setLikeState({ liked, count, busy: true });
    setError('');
    try {
      const result = await api.toggleLike(post._id);
      const resolved = {
        liked: Boolean(result.liked),
        count: Number(result.likeCount) || 0,
        busy: false,
      };
      setLikeState(resolved);
      if (onChanged) {
        onChanged({ ...post, likedByMe: resolved.liked, likeCount: resolved.count });
      }
    } catch (err) {
      setLikeState(previous);
      setError(err.status === 401 ? 'Sign in to like this post.' : 'Could not update your like.');
      if (err.status === 401) navigate('/login');
    }
  }

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

  // Instagram-style card order: author and posted date on top, media/content in
  // the middle, and every action together at the end. Putting the date where
  // the action row used to be keeps the top line balanced.
  const date = (
    <p className="post-date post-head-date">
      <Link className="post-permalink" to={`/post/${post._id}`}>{post.postedDate}</Link>
    </p>
  );

  const actions = (
    <div className="post-card-footer">
      <div className="post-card-actions">
        <button
          type="button"
          className={`fav-btn post-like${likeState.liked ? ' is-active' : ''}`}
          aria-pressed={likeState.liked}
          aria-busy={likeState.busy}
          disabled={likeState.busy}
          aria-label={likeState.liked
            ? `Unlike this post${likeState.count ? `, ${likeState.count} likes` : ''}`
            : `Like this post${likeState.count ? `, ${likeState.count} likes` : ''}`}
          title={likeState.liked ? 'Unlike' : 'Like'}
          onClick={handleLike}
        >
          <span className="material-symbols-rounded">
            {likeState.liked ? 'favorite' : 'favorite_border'}
          </span>
          {likeState.count > 0 && <span className="post-like-count">{likeState.count}</span>}
        </button>
        <div className="post-action-group">
          <button type="button" className="post-share" data-share-url={permalink}
                  title="Copy link to this post" aria-label="Copy link to this post">
            <span className="material-symbols-rounded">share</span>
          </button>
          {owned && (
            <div className="post-more" ref={moreRef}>
              <button
                ref={moreButtonRef}
                type="button"
                className={`post-share post-more-btn${menuOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? moreMenuId : undefined}
                title="More options"
                aria-label="More options"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span className="material-symbols-rounded">more_vert</span>
              </button>
              {menuOpen && (
                <div className="post-more-menu" id={moreMenuId} role="menu" aria-label="Post options">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setEditing(true);
                    }}
                  >
                    <span className="material-symbols-rounded" aria-hidden="true">edit</span>
                    Edit post
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={deleting}
                    onClick={() => {
                      setMenuOpen(false);
                      handleDelete();
                    }}
                  >
                    <span className="material-symbols-rounded" aria-hidden="true">
                      {deleting ? 'hourglass_top' : 'delete'}
                    </span>
                    {deleting ? 'Deleting…' : 'Delete post'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
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

        {date}
      </div>

      {error && <p className="post-error" role="alert">{error}</p>}

      {post.isVideo ? (
        <>
          <div className="post-video-embed">
            <iframe src={`https://www.youtube.com/embed/${post.content}`} allowFullScreen title="Embedded video" />
          </div>
          {post.reference && <p className="post-reference">{post.reference}</p>}
          {actions}
        </>
      ) : (
        <>
          <p className="post-content">{post.content}</p>
          {post.reference && <p className="post-reference">Reference: {post.reference}</p>}
          {actions}
        </>
      )}
    </div>
  );
}

export function PostsPage() {
  const { isLoggedIn } = useSession();
  const [data, setData] = useState({ loading: true, posts: [], permalinkBase: '' });
  const [composing, setComposing] = useState(false);
  const [filter, setFilter] = useState('all');

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

  useEffect(() => {
    if (!isLoggedIn) setFilter('all');
  }, [isLoggedIn]);

  const likedCount = data.posts.filter((post) => post.likedByMe).length;
  const visiblePosts = filter === 'liked'
    ? data.posts.filter((post) => post.likedByMe)
    : data.posts;

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

        {isLoggedIn && (
          <button
            type="button"
            className={`post-filter-toggle${filter === 'liked' ? ' is-active' : ''}`}
            aria-pressed={filter === 'liked'}
            aria-label={filter === 'liked' ? 'Show all posts' : 'Show liked posts'}
            title={filter === 'liked' ? 'Show all posts' : 'Show liked posts'}
            onClick={() => setFilter((current) => (current === 'liked' ? 'all' : 'liked'))}
          >
            <span className="material-symbols-rounded" aria-hidden="true">
              {filter === 'liked' ? 'favorite' : 'favorite_border'}
            </span>
            Liked
            <span className="post-filter-count">{likedCount}</span>
          </button>
        )}
      </div>

      {composing && (
        <PostForm
          onClose={() => setComposing(false)}
          onSaved={async () => { setComposing(false); await load(); }}
        />
      )}

      {data.loading ? <Loader variant="inline" label="Loading posts" /> : data.posts.length === 0 ? (
        <p className="post-empty">No posts yet.</p>
      ) : visiblePosts.length === 0 ? (
        <p className="post-empty">You have not liked any posts yet.</p>
      ) : (
        visiblePosts.map((post) => (
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