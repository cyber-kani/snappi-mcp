// CORS preflight for the token endpoint.
import { setOAuthCors } from '~~/server/utils/oauth'

export default defineEventHandler((event) => {
  setOAuthCors(event)
  setResponseStatus(event, 204)
  return null
})
