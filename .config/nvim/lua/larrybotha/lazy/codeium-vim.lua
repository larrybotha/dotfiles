return {
  -- note, different to codeium.nvim which relies on nvim-cmp

  'Exafunction/codeium.vim',
  init = function()
    vim.g.codeium_no_map_tab = 0

    local opts = { expr = true, silent=true }

    vim.keymap.set('i', '<C-g><C-g>', vim.fn['codeium#Accept'], opts)
    vim.keymap.set('i', '<C-g><C-n>', function() return vim.fn['codeium#CycleCompletions'](1) end, opts)
    vim.keymap.set('i', '<C-g><C-p>', function() return vim.fn['codeium#CycleCompletions'](-1) end, opts)
    vim.keymap.set('i', '<C-g><C-c>', vim.fn['codeium#Clear'], opts)
  end
}
