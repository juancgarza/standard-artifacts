// stdartifacts.com (and www) → standardartifacts.com, keeping the path and query.
export default {
  fetch(request) {
    const url = new URL(request.url)
    return Response.redirect(`https://standardartifacts.com${url.pathname}${url.search}`, 301)
  },
}
