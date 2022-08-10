local nvim_lsp = require "lspconfig"
local cmp_nvim_lsp = require("cmp_nvim_lsp")

local M = {}

local custom_lua_lsp = require "modules/lsp/lua-language-server"

local on_attach = function(client, bufnr)
    local function buf_set_keymap(...)
        vim.api.nvim_buf_set_keymap(bufnr, ...)
    end
    local function buf_set_option(...)
        vim.api.nvim_buf_set_option(bufnr, ...)
    end

    buf_set_option("omnifunc", "v:lua.vim.lsp.omnifunc")

    -- Mappings.
    local opts = {noremap = true, silent = true}
    buf_set_keymap("n", "gD", "<Cmd>lua vim.lsp.buf.declaration()<CR>", opts)
    buf_set_keymap("n", "gd", "<Cmd>lua vim.lsp.buf.definition()<CR>", opts)
    buf_set_keymap("n", "<C-]>", "<Cmd>lua vim.lsp.buf.definition()<CR>", opts)
    buf_set_keymap("n", "K", "<Cmd>lua vim.lsp.buf.hover()<CR>", opts)
    buf_set_keymap("n", "gi", "<cmd>lua vim.lsp.buf.implementation()<CR>", opts)
    buf_set_keymap("n", "<space>D", "<cmd>lua vim.lsp.buf.type_definition()<CR>", opts)
    buf_set_keymap("n", "<space>ca", "<cmd>lua vim.lsp.buf.code_action()<CR>", opts)
    buf_set_keymap("n", "[d", "<cmd>lua vim.diagnostic.goto_prev()<CR>", opts)
    buf_set_keymap("n", "]d", "<cmd>lua vim.diagnostic.goto_next()<CR>", opts)
    buf_set_keymap("n", "<leader>rn", "<cmd>lua vim.lsp.buf.rename()<CR>", opts)

    -- not sure if telescope.builtin.lsp_references matches this output
    -- so we keep this mapping enabled
    -- see .vim/local/plugins/telescope.vim for the telescope key mapping
    buf_set_keymap("n", "fR", "<cmd>lua vim.lsp.buf.references()<CR>", opts)

    --buf_set_keymap('n', '<space>wa', '<cmd>lua vim.lsp.buf.add_workspace_folder()<CR>', opts)
    --buf_set_keymap('n', '<space>wr', '<cmd>lua vim.lsp.buf.remove_workspace_folder()<CR>', opts)
    --buf_set_keymap('n', '<space>wl', '<cmd>lua print(vim.inspect(vim.lsp.buf.list_workspace_folders()))<CR>', opts)
    --buf_set_keymap('n', '<C-k>', '<cmd>lua vim.lsp.buf.signature_help()<CR>', opts) -- conflicts with <C-K> navigation
    --buf_set_keymap('n', '<space>e', '<cmd>lua vim.diagnostic.show_line_diagnostics()<CR>', opts)
    --buf_set_keymap('n', '<space>q', '<cmd>lua vim.diagnostic.set_loclist()<CR>', opts)

    -- Set some keybinds conditional on server capabilities
    if client.resolved_capabilities.document_formatting then
        buf_set_keymap("n", "<space>f", "<cmd>lua vim.lsp.buf.formatting()<CR>", opts)
    end
    if client.resolved_capabilities.document_range_formatting then
        buf_set_keymap("v", "<space>f", "<cmd>lua vim.lsp.buf.range_formatting()<CR>", opts)
    end

    -- Set autocommands conditional on server_capabilities
    if client.resolved_capabilities.document_highlight then
        vim.api.nvim_exec(
            [[
              hi LspReferenceRead cterm=bold ctermbg=red guibg=LightYellow
              hi LspReferenceText cterm=bold ctermbg=red guibg=LightYellow
              hi LspReferenceWrite cterm=bold ctermbg=red guibg=LightYellow

              augroup lsp_document_highlight
                autocmd! * <buffer>
                autocmd CursorHold <buffer> lua vim.lsp.buf.document_highlight()
                autocmd CursorMoved <buffer> lua vim.lsp.buf.clear_references()
                autocmd CursorHold <buffer> lua vim.diagnostic.open_float(nil, { focusable = false })
              augroup END
            ]],
            false
        )
    end
end

-- Use a loop to conveniently both setup defined servers
-- and map buffer local keybindings when the language server attaches
nvim_lsp.custom_lua_lsp = custom_lua_lsp
local server_configs = {
    {name = "custom_lua_lsp", options = {}},
    {name = "ansiblels", options = {}},
    {name = "bashls", options = {}},
    {name = "cssls", options = {}},
    {name = "dockerls", options = {}},
    {name = "gopls", options = {}},
    {name = "html", options = {filetypes = {"html", "htmldjango"}}},
    {name = "intelephense", options = {}},
    {name = "jsonls", options = {}},
    {name = "pyright", options = {}},
    {name = "svelte", options = {}},
    {name = "terraformls", options = {}},
    {name = "tsserver", options = {}},
    {name = "vimls", options = {}},
    {name = "yamlls", options = {}}
}
for _, config in ipairs(server_configs) do
    local attach_options = {
        on_attach = on_attach,
        capabilities = cmp_nvim_lsp.update_capabilities(vim.lsp.protocol.make_client_capabilities())
    }
    local options = config.options

    for k, v in pairs(attach_options) do
        options[k] = v
    end

    nvim_lsp[config.name].setup(options)
end

M.on_attach = on_attach

return M
