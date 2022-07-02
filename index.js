import challenge from 'pkce-challenge';
import moment from 'moment';
import useInterval from 'use-interval';
import debug from 'debug';
import React, {
  useState,
  useEffect,
  useContext,
  createContext,
  useCallback,
} from 'react';
import PropTypes from 'prop-types';

const STATE = Symbol('STATE');

const log = debug('discord:log');
const error = debug('discord:error');
error.log = console.error.bind(console); // eslint-disable-line no-console
const info = debug('discord:info');
info.log = console.info.bind(console); // eslint-disable-line no-console

/**
 * @param {string} client_id
 * @param {string} redirect_uri
 * @param {[string]} scopes
 */
const login = ({ client_id, redirect_uri, scopes }) => {
  const { code_challenge, code_verifier } = challenge(128);
  navigator.serviceWorker.controller.postMessage({
    type: 'use-discord',
    client_id,
    code_verifier,
    redirect_uri,
  });

  const url = new URL('https://discord.com/api/oauth2/authorize');
  url.search = new URLSearchParams({
    client_id,
    code_challenge,
    code_challenge_method: 'S256',
    redirect_uri,
    response_type: 'code',
    scope: scopes.join(' '),
  });
  window.open(url.toString(), '_blank', 'popup=1');
};

const expired = (at) => moment(at).isBefore(moment());
const membersUrl = (guild) => `https://discord.com/api/users/@me/guilds/${guild}/member`;

/**
 * @typedef {{[server: string]: [string]}} RoleList
 */

/**
 * @typedef {{avatar: string, username: string, id: string}} DiscordUser
 */

/**
 * @typedef DiscordArgs
 * @property {[string]} guilds
 * @property {string} client_id
 * @property {string} redirect_uri
 * @property {[string]} scopes
 */

/**
 * @typedef DiscordState
 * @property {[Error]} errors
 * @property {()=>void} clearErrors
 * @property {RoleList} roles
 * @property {string} uid
 * @property {string} username
 * @property {string} avatar
 * @property {boolean} isLoggedIn
 * @property {() => void} login
 * @property {() => void} logout
 */

/**
 * @param {DiscordArgs} arg0
 * @return {DiscordState}
 */
const discord = ({ guilds, ...opts }) => {
  const [tokens, setTokens] = useState(JSON.parse(localStorage.getItem('discord:token') || '{}'));
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [errors, setErrors] = useState([]);
  const [last, setLast] = useState(localStorage.getItem('discord:last') || '');


  /** @type {[RoleList, (roles: RoleList) => void]} */
  const [roles, setRoles] = rolesState = useState(JSON.parse(localStorage.getItem('discord:roles') || '{}'));

  /** @type {[DiscordUser, (user: DiscordUser) => void]} */
  const [user, setUser] = useState(JSON.parse(localStorage.getItem('discord:user') || '{}'));

  useEffect(() => {
    const { access_token, refresh_token, expires_at } = tokens;
    if (!access_token || !refresh_token || !expires_at) {
      setIsLoggedIn(false);
      setUser({});
      setRoles({});
      return;
    }

    if (expired(expires_at)) {
      setTokens({});
    } else {
      setIsLoggedIn(true);
    }
  }, [tokens]);

  const handler = (event) => {
    if (event.data.type === 'use-discord') {
      const { data } = event.data;
      data.expires_at = moment().add(data.expires_in, 'seconds').toISOString();
      setTokens(data);
    }
  };
  useEffect(() => {
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  const updateRoles = useCallback(async () => {
    if (!isLoggedIn) return;
    if (!tokens.access_token) return;
    if (user.avatar && user.id && user.username) {
      if (last && moment(last).add(30, 'minutes').isAfter(moment())) return;
    }

    const ops = { headers: { authorization: `Bearer ${tokens.access_token}` } };
    const entries = guilds.map((g) => [g, fetch(membersUrl(g), ops).then((r) => r.json())]);
    const newroles = Object.fromEntries(entries);

    const es = [];
    let readuser = false;

    // eslint-disable-next-line no-restricted-syntax
    for await (const [guild, prom] of entries) {
      try {
        const rsp = await prom;
        log('raw role resp: %O', rsp);

        const { user: { id, avatar, username } = {} } = rsp;
        if (!readuser && id) {
          readuser = true;
          setUser({
            avatar: `https://cdn.discordapp.com/avatars/${id}/${avatar}.png?size=32`,
            id,
            username,
          });
        }

        newroles[guild] = rsp.roles;
      } catch (e) {
        es.push(e);
      }
    }

    setErrors(es);
    if (es.length) {
      es.forEach((e) => error(e));
      setTokens({});
    } else {
      log('roles: %O', newroles);
      setRoles(newroles);
      setLast(moment().toISOString());
    }
  }, [isLoggedIn, tokens, user, errors, last]);

  useEffect(updateRoles, [user, tokens, isLoggedIn]);
  useInterval(updateRoles, 60 * 60 * 1000); // refresh every hour

  useEffect(() => localStorage.setItem('discord:token', JSON.stringify(tokens)), [tokens]);
  useEffect(() => localStorage.setItem('discord:user', JSON.stringify(user)), [user]);
  useEffect(() => localStorage.setItem('discord:roles', JSON.stringify(roles)), [roles]);
  useEffect(() => localStorage.setItem('discord:last', last), [last]);

  const clearErrors = () => setErrors([]);
  return {
    errors,
    clearErrors,
    roles,
    uid: user.id || '',
    username: user.username || '',
    avatar: user.avatar || '',
    isLoggedIn,
    login: () => login(opts),
    logout: () => setTokens({}),
  };
};

/** @type {React.Context<DiscordState>} */
const ctx = createContext(null);
export const useDiscord = () => useContext(ctx);

/**
 *
 * @typedef {Object} DiscordProviderOptions
 * @property {string} client_id
 * @property {string} [redirect_uri]
 * @property {[string]} [scopes]
 * @property {[string]} guilds
 */
/** @param {DiscordProviderOptions} options */
export const DiscordProvider = ({
  children,
  client_id,
  redirect_uri = `${window.location.origin}/discord`,
  scopes = ['identify', 'guilds.members.read'],
  guilds = [],
}) => {
  if (!guilds?.length) throw new Error('You must specify at least 1 guild in guilds param DiscordProvider.');

  const { Provider } = ctx;
  return (
    <Provider value={discord({ client_id, redirect_uri, scopes, guilds })}>
      {children}
    </Provider>
  );
};
DiscordProvider.propTypes = {
  children: PropTypes.any,
  client_id: PropTypes.string.isRequired,
  redirect_uri: PropTypes.string,
  scopes: PropTypes.arrayOf(PropTypes.string.isRequired),
  guilds: PropTypes.arrayOf(PropTypes.string.isRequired),
};

export const onMessageHandler = (event) => {
  if (event.data.type !== 'use-discord') return false;
  globalThis[STATE] = event.data;
  return true;
};

export const fetchHandler = (event) => {
  if (!globalThis[STATE]) return false;
  const { client_id, redirect_uri, code_verifier } = globalThis[STATE] || {};

  const url = new URL(event.request.url);
  if (!url.href.startsWith(redirect_uri) || !url.searchParams.get('code')) return false;

  event.respondWith((async () => {
    const body = new URLSearchParams({
      client_id,
      redirect_uri,
      response_type: 'token',
      grant_type: 'authorization_code',
      code: url.searchParams.get('code'),
      code_verifier,
    });
    const req = new Request('https://discord.com/api/oauth2/token', { body, method: 'POST' });
    const resp = await fetch(req);
    const data = await resp.json();
    const clients = await globalThis.clients.matchAll();
    clients.forEach((client) => client.postMessage({ type: 'use-discord', data }));

    delete globalThis[STATE];
    return new Response('<script type="application/javascript">window.close();</script>', {
      headers: { 'Content-Type': 'text/html' },
      status: 200,
    });
  })());

  return true;
};
