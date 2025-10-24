---

title_line1: 所有文章

layout: articles-list.njk

pagination:
  data: collections.articles
  size: 10       # 每页显示 10 篇文章
  reverse: true  # 最新的文章排在前面
  alias: articles

permalink: "articles-list/{{ pagination.pageNumber }}/index.html"

---

---
