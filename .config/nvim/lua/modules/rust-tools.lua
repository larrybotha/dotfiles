local nvim_lsp = require "./modules/lsp/init"

local options = {
    tools = {
        autoSetHints = true,
        hover_actions = {
            -- the border that is used for the hover window
            -- see vim.api.nvim_open_win()
            border = {
                {"╭", "FloatBorder"},
                {"─", "FloatBorder"},
                {"╮", "FloatBorder"},
                {"│", "FloatBorder"},
                {"╯", "FloatBorder"},
                {"─", "FloatBorder"},
                {"╰", "FloatBorder"},
                {"│", "FloatBorder"}
            },
            max_width = nil,
            max_height = nil,
            auto_focus = false
        },
        runnables = {use_telescope = true},
        inlay_hints = {
            -- Only show inlay hints for the current line
            --only_current_line = false,
            -- whether to show parameter hints with the inlay hints or not
            -- default: true
            show_parameter_hints = true,
            -- prefix for parameter hints
            -- default: "<-"
            parameter_hints_prefix = "<- ",
            -- prefix for all the other hints (type, chaining)
            -- default: "=>"
            other_hints_prefix = "=> "
        }
    },
    -- all the options to send to nvim-lspconfig
    -- these override the defaults set by rust-tools.nvim
    -- see https://github.com/neovim/nvim-lspconfig/blob/master/CONFIG.md#rust_analyzer
    server = {
        on_attach = nvim_lsp.on_attach,
        settings = {
            -- to enable rust-analyzer settings visit:
            -- https://github.com/rust-analyzer/rust-analyzer/blob/master/docs/user/generated_config.adoc
            ["rust-analyzer"] = {
                -- HACK: https://github.com/simrat39/rust-tools.nvim/issues/300
                inlayHints = {locationLinks = false},
                -- enable clippy on save
                checkOnSave = {
                    command = "clippy"
                }
            }
        }
    }
}

require("rust-tools").setup(options)
