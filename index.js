import React, { useState, useEffect, useContext, createContext, useCallback } from 'react';
import { Promise } from 'bluebird';
import challenge from 'pkce-challenge';
import moment from 'moment';
import useInterval from 'use-interval';
import debug from 'debug';

const STATE = Symbol('STATE');

const log = debug('discord:log');
const error = debug('discord:error');
error.log = console.error.bind(console);
const info = debug('discord:info');
info.log = console.info.bind(console);

const login = ({client_id, redirect_uri, scopes}) => {
  const { code_challenge, code_verifier } = challenge(128);
  navigator.serviceWorker.controller.postMessage({ type: 'use-discord', code_verifier, redirect_uri, client_id });
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

/**
 * @param {[string]} guilds
 */
const discord = ({guilds, ...opts}) => {
  const [tokens, setTokens] = useState(JSON.parse(localStorage.getItem('discord:token') || '{}'));
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [errors, setErrors] = useState([]);
  const [last, setLast] = useState(localStorage.getItem('discord:last') || '');

  const rolesState = useState(JSON.parse(localStorage.getItem('discord:roles') || '{}'));
  /** @type {{[server: string]: [string]}} */
  const roles = rolesState[0];
  const setRoles = rolesState[1];

  const userState = useState(JSON.parse(localStorage.getItem('discord:user') || '{}'));
  /** @type {{ avatar: string, username: string, id: string }} */
  const user = userState[0];
  const setUser = userState[1];

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

  const updateRoles = useCallback(() => {
    if (!isLoggedIn) return;
    if (user.avatar && user.id && user.username) {
      if (last && moment(last).add(30, 'minutes').isAfter(moment())) return;
    }

    const options = { headers: { authorization: `Bearer ${tokens.access_token}` } };

    Promise.props(
      Object.fromEntries(guilds.map(guild => [
        guild,
        fetch(`https://discord.com/api/users/@me/guilds/${guild}/member`, options)
          .then(r => r.json()),
      ]))
    )
    .then(rsp => {
      log('raw role resp: %O', rsp);
      const u = Object.values(rsp)
        .map(val => val.user)
        .find((val) => Boolean(val));

      u && setUser({
        avatar: `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=32`,
        id: u.id,
        username: u.username,
      });
      return rsp;
    })
    .then(rsp => Object.entries(rsp).reduce((prev, [key, val]) => {
      prev[key] = val.roles;
      return prev;
    }, {}))
    .tap(o => log('roles: %O', o))
    .then(setRoles)
    .then(() => setLast(moment().toISOString()))
    .tapCatch(error)
    .tapCatch(e => setErrors(...errors, e))
    .catch(() => setTokens({}));
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
  redirect_uri = `${location.origin}/discord`,
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

export const onMessageHandler = (event) => {
  if (event.data.type !== 'use-discord') return;
  self[STATE] = event.data;
  return true;
};

export const fetchHandler = (event) => {
  if (!self[STATE]) return;
  const { client_id, redirect_uri, code_verifier } = self[STATE] || {};

  const url = new URL(event.request.url);
  if (!url.href.startsWith(redirect_uri) || !url.searchParams.get('code'))  return;

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
    const clients = await self.clients.matchAll();
    clients.forEach(client => client.postMessage({ type: 'use-discord', data }));

    delete self[STATE];
    return new Response('<script type="application/javascript">window.close();</script>', {
      headers: { 'Content-Type': 'text/html' },
      status: 200,
    });
  })());

  return true;
};

