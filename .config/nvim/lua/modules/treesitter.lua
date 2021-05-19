require "nvim-treesitter.configs".setup {
    -- one of "all", "maintained" (parsers with maintainers), or a list of languages
    ensure_installed = "maintained",
    -- List of parsers to ignore installing
    --ignore_install = { "javascript" },
    highlight = {
        -- false will disable the whole extension
        enable = true,
        -- list of language that will be disabled
        disable = {}
    }
}
