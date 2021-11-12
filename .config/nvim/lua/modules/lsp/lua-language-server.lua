-- see https://www.chrisatmachine.com/Neovim/28-neovim-lua-development/ for how to
--install the lua-language-server

local M = {}
local system_name

if vim.fn.has("mac") == 1 then
    system_name = "macOS"
elseif vim.fn.has("unix") == 1 then
    system_name = "Linux"
elseif vim.fn.has("win32") == 1 then
    system_name = "Windows"
else
    print("Unsupported system for sumneko")
end

-- install the language server at ~/code/lua-language-server
-- see https://github.com/sumneko/lua-language-server/wiki/Build-and-Run
local sumneko_root_path = os.getenv("HOME") .. "/code/lua-language-server"
local sumneko_binary = sumneko_root_path .. "/bin/" .. system_name .. "/lua-language-server"

function M.setup(opts)
    opts = opts or {}
    opts.cmd = {sumneko_binary, "-E", sumneko_root_path .. "/main.lua"}
    opts.settings = {
        Lua = {
            runtime = {
                version = "LuaJIT",
                path = vim.split(package.path, ";")
            },
            diagnostics = {
                -- Get the language server to recognize the `vim` global
                globals = {"vim"}
            },
            workspace = {
                -- Make the server aware of Neovim runtime files
                library = {
                    [vim.fn.expand("$VIMRUNTIME/lua")] = true,
                    [vim.fn.expand("$VIMRUNTIME/lua/vim/lsp")] = true
                }
            },
            -- Do not send telemetry data containing a randomized but unique identifier
            telemetry = {
                enable = false
            }
        }
    }

    require "lspconfig".sumneko_lua.setup(opts)
end

return M
