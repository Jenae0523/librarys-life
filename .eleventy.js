const { DateTime } = require("luxon");

module.exports = function(eleventyConfig) {
  // ====== 全局资源域名变量 ======
  eleventyConfig.addGlobalData("resourcesUrl", "https://toonwoo.com");

  // ====== 静态资源直通（复制到 _site） ======
  eleventyConfig.addPassthroughCopy("css261");
  eleventyConfig.addPassthroughCopy("site-img");
  eleventyConfig.addPassthroughCopy("img");

  // ====== 手动静态 HTML 页面直通 ======
  // 复制根目录的所有 HTML 文件（index.html、Donor-Acknowledgment.html 等）
  eleventyConfig.addPassthroughCopy("*.html");

  // 复制 about 文件夹及其中所有文件
  eleventyConfig.addPassthroughCopy({ "about": "about" });

  // ====== 自定义日期格式化 ======
  eleventyConfig.addFilter("dateCN", (dateObj) => {
    if (!dateObj) return "";
    return DateTime.fromJSDate(dateObj).toFormat("yyyy年M月d日");
  });

  // ====== 全局版本号 ======
  eleventyConfig.addGlobalData("version", () => {
    return DateTime.now().toFormat("yyyyMMdd-HHmm");
  });

  // ====== 为 free-ebooks 自动指定 ebook.njk 布局 ======
  eleventyConfig.addGlobalData("eleventyComputed", {
    layout: (data) => {
      if (data.page && data.page.inputPath && data.page.inputPath.includes("free-ebooks")) {
        return "ebook.njk";
      }
      return data.layout;
    }
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      layouts: "_layouts",
      output: "_site"
    },
    passthroughFileCopy: true,
	pathPrefix: "/librarys-life/"   // ← 新增这一行，GitHub仓库名
  };
};
