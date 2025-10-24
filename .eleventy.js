const { DateTime } = require("luxon");

module.exports = function(eleventyConfig) {
  // ====== 全局资源域名变量 ======
  eleventyConfig.addGlobalData("resourcesUrl", "https://toonwoo.com");

  // ====== 静态资源直通（本地服务器需要的才保留） ======
  // 这些目录会被复制到 _site
  eleventyConfig.addPassthroughCopy("css261");
  eleventyConfig.addPassthroughCopy("site-img");
  eleventyConfig.addPassthroughCopy("img");

  // ====== 自定义日期格式化 ======
  eleventyConfig.addFilter("dateCN", (dateObj) => {
    if (!dateObj) return "";
    return DateTime.fromJSDate(dateObj).toFormat("yyyy年M月d日");
  });
  
  // ====== 全局版本号 ======
  eleventyConfig.addGlobalData("version", () => {
    // 返回构建时的时间版本号，格式：yyyyMMdd-HHmm
    return DateTime.now().toFormat("yyyyMMdd-HHmm");
  });  
  
  // ====== 为 free-ebooks 自动指定 ebook.njk 布局 ======
  eleventyConfig.addGlobalData("eleventyComputed", {
    layout: (data) => {
      if (data.page && data.page.inputPath && data.page.inputPath.includes("free-ebooks")) {
        return "ebook.njk";
      }
      return data.layout; // 保留其他目录的原本布局
    }
  });

  return {
    dir: {
      input: "src",
      includes: "_includes",
      layouts: "_layouts",
      output: "_site"
    },
    passthroughFileCopy: true
  };
};
