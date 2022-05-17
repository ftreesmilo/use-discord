# use-discord
A React context hook to log in using a Discord identity without a server-side
component.

The code will refresh login and role status every hour. I use a service worker
to handle the redirect_uri.  I'll work on getting that added as something you
can import and stick in your fetch handler.

## Installation
```bash
npm i use-discord
```

## Use
In your app's root somewhere:
```jsx
    <DiscordProvider
      client_id={'969261945310031913'}
      guilds={['783410937902006374', '551763693378076683']}
    >
      <TheRestOfYourApp />
    </DiscordProvider>
```

In a component hook:
```js
const MyComponent = () => {
  const discord = useDiscord();
  return <Menu>
    {
      discord.isLoggedIn
        ? <MenuItem onClick={discord.logout}>Log out of Discord</MenuItem>
        : <MenuItem onClick={discord.login}>
            <Typography>Log in to Discord</Typography>
          </MenuItem>
    }
  </Menu>
}
```

In your service worker:
```js
const { onMessageHandler, fetchHandler } = require('use-discord');

addEventListener('fetch', async (event) => {
  if (fetchHandler(event)) return;

  ...
});
addEventListener('message', onMessageHandler);

```

### Provider options:

#### client_id
The client ID you get when
[registering your "app" with discord.](https://discord.com/developers/applications)

#### guilds
An array of strings that represent all the guilds you wish to look for roles on.

#### scopes
An array of strings that represent the scopes that this hook will request.
Default: `['identify', 'guilds.members.read']`

#### redirect_uri
Where discord will send the user during authorization flow.
Default: `${location.origin}/discord`

### Available actions

#### login
Initiate the login flow.

#### logout
Log the user out in this app. This will reset the state as well.

### Available state

#### avatar
String - A url that points to an avatar of the user. For example:
```js
'https://cdn.discordapp.com/avatars/8574465478869584/7437496069584a98685e96968.png?size=32'
```

#### isLoggedIn
Boolean - true if the user is logged in, otherwise false.

#### roles
Dictionary - A map of guild to array of roles that a uer has. For example:
```js
{
  '12325234234234234': ['324234232523412341241', '23423512342345234123']
}
```

#### uid
String - The user id in discord. For example:
```js
'235436523432652'
```

#### username
String - The username for the user. For example:
```js
'ftreesmilo'
```

