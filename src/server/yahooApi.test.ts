import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appFor, authUrl } from './yahooApi.js'

test('the consent request names the Fantasy permission it needs', () => {
  /*
   * Left off, Yahoo issued a token that authenticated and was then refused by
   * the Fantasy API with additional_authorization_required — indistinguishable
   * from the grant never having been provisioned. The test that was meant to
   * answer that question could not, because of a missing parameter.
   */
  process.env.YAHOO_CLIENT_ID = 'id'
  delete process.env.YAHOO_SCOPE
  const q = new URL(authUrl('st')).searchParams
  assert.equal(q.get('scope'), 'fspt-r')
  assert.equal(q.get('state'), 'st', 'and still carries the state that guards the callback')
  assert.equal(q.get('response_type'), 'code')
})

test('the scope can be respelled without a code change', () => {
  process.env.YAHOO_SCOPE = 'openid fspt-r'
  assert.equal(new URL(authUrl('st')).searchParams.get('scope'), 'openid fspt-r')
  delete process.env.YAHOO_SCOPE
})

test('a connection says which application granted it', () => {
  /*
   * Two applications were submitted and Yahoo's approval named neither. A
   * refresh token belongs to the app that minted it, so a token from the first
   * with credentials from the second fails exactly like access that was never
   * granted — and "connected: true" said nothing about which.
   */
  const id = 'dj0yJmk9' + 'x'.repeat(84) + 'PWRj'
  assert.deepEqual(appFor({ client: id }, id), { connectedWithClientIdTail: 'PWRj', sameApp: true })
  assert.deepEqual(appFor({ client: id }, 'dj0yJmk9other'),
    { connectedWithClientIdTail: 'PWRj', sameApp: false })
})

test('a connection made before that was recorded admits it does not know', () => {
  assert.deepEqual(appFor({}, 'dj0yJmk9x'), { connectedWithClientIdTail: null, sameApp: null })
  assert.deepEqual(appFor(null, 'dj0yJmk9x'), { connectedWithClientIdTail: null, sameApp: null })
})
