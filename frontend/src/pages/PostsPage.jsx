import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { posts as api } from '../services/api';
import Loader from '../components/Loader';
import NotFound from './NotFound';

// Reuses views/post-card.ejs's markup, which the shared stylesheet already
// styles. The card is factored out because the feed, a profile and a permalink
// all render it, and three copies is how they drift.
export function PostCard({ post, permalinkBase = '' }) {
  const handle = post.author && post.author.username ? post.author.username : null;
  const permalink = permalinkBase + '/post/' + post._id;

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

        <button type="button" className="post-share" data-share-url={permalink} title="Copy link to this post">
          <span className="material-symbols-rounded">link</span>
          <span className="post-share-label">Share</span>
        </button>
      </div>

      {post.isVideo ? (
        <>
          <div className="post-video-embed">
            <iframe src={`https://www.youtube.com/embed/${post.content}`} allowFullScreen title="Embedded video" />
          </div>
          {post.reference && <p className="post-reference">{post.reference}</p>}
        </>
      ) : (
        <>
          <p className="post-content">{post.content}</p>
          {post.reference && <p className="post-reference">Reference: {post.reference}</p>}
        </>
      )}

      <p className="post-date">
        <Link className="post-permalink" to={`/post/${post._id}`}>{post.postedDate}</Link>
      </p>
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
        <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
          <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>edit_note</span>
          Add Post
        </button>
        <button type="button" className="btn btn-outline-primary" onClick={() => setComposing(true)}>
          <span className="material-symbols-rounded" style={{ fontSize: '1.1rem' }}>videocam</span>
          Add Video
        </button>
      </div>

      {composing && (
        <ComposeForm onClose={() => setComposing(false)} onSaved={async () => { setComposing(false); await load(); }} />
      )}

      {data.loading ? <Loader variant="inline" label="Loading posts" /> : data.posts.length === 0 ? (
        <p className="post-empty">No posts yet.</p>
      ) : (
        data.posts.map((post) => <PostCard key={post._id} post={post} permalinkBase={data.permalinkBase} />)
      )}
    </>
  );
}

function ComposeForm({ onClose, onSaved }) {
  const [isVideo, setIsVideo] = useState(false);
  const [link, setLink] = useState('');
  const [content, setContent] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // youtu.be/<id>?... -> <id>; otherwise pass through, matching the EJS route.
  function extractId(raw) {
    const match = String(raw || '').split('youtu.be/')[1];
    return match ? match.split('?')[0] : String(raw || '').trim();
  }

  async function submit() {
    setSaving(true);
    setError('');
    try {
      await api.create({
        content: isVideo ? extractId(link) : content,
        reference: isVideo ? descriptionOf() : reference,
        isVideo
      });
      await onSaved();
    } catch (err) {
      setError(err.status === 401 ? 'Sign in to add a post.' : 'Could not save that post.');
    } finally {
      setSaving(false);
    }
  }

  // For a video the "reference" is the description, which is what the EJS form
  // submitted too - one field, different label.
  const descriptionOf = () => reference;

  return (
    <div className="container1">
      <div className="card-header"><h3>{isVideo ? 'Add Video' : 'Add Post'}</h3></div>

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
        <button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-outline" style={{ marginLeft: '0.5rem' }} onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-link" style={{ marginLeft: '0.5rem' }} onClick={() => setIsVideo((v) => !v)}>
          {isVideo ? 'Post text instead' : 'Post a video instead'}
        </button>
      </div>
    </div>
  );
}

export function PostPage() {
  const { id } = useParams();
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

      <PostCard post={post} permalinkBase={state.permalinkBase} />
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
        posts.map((post) => <PostCard key={post._id} post={post} permalinkBase={permalinkBase} />)
      )}
    </>
  );
}