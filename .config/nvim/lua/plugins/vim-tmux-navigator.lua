M = {}

M.set_is_vim = function()
  vim.cmd("silent !tmux set-option -p @custom_is_vim yes")
end

M.unset_is_vim = function()
  vim.cmd("silent !tmux set-option -p -u @custom_is_vim")
end

local function create_autocommands(definitions)
  for group_name, definition in pairs(definitions) do
    vim.api.nvim_command("augroup " .. group_name)
    vim.api.nvim_command("autocmd!")

    for _, def in ipairs(definition) do
      local command = table.concat(vim.tbl_flatten{"autocmd", def}, " ")
      vim.api.nvim_command(command)
    end

    vim.api.nvim_command("augroup END")
  end
end

local autocmds = {
  custom_is_vim = {
    {"VimEnter", "*", ":lua require('plugins/vim-tmux-navigator').set_is_vim()"},
    {"VimLeave", "*", ":lua require('plugins/vim-tmux-navigator').unset_is_vim()"},
    {"VimSuspend", "*", ":lua require('plugins/vim-tmux-navigator').unset_is_vim()"},
    {"VimResume", "*", ":lua require('plugins/vim-tmux-navigator').set_is_vim()"},
  }
}

M.lazy_config = {
  "christoomey/vim-tmux-navigator",
  lazy=false,
  init = function()
    create_autocommands(autocmds)
  end,
  ini = function()
    -- See: https://github.com/christoomey/vim-tmux-navigator/issues/295#issuecomment-1123455337
    vim.cmd([[
      function! s:set_is_vim()
        silent execute '!tmux set-option -p @custom_is_vim yes'
      endfunction

      function! s:unset_is_vim()
        silent execute '!tmux set-option -p -u @custom_is_vim'
      endfunction

      if has("autocmd")
        autocmd!
        autocmd VimEnter * call s:set_is_vim()
        autocmd VimLeave * call s:unset_is_vim()

        if exists("##VimSuspend")
          autocmd VimSuspend * call s:unset_is_vim()
          autocmd VimResume * call s:set_is_vim()
        endif
      endif
    ]])
  end
}

return M
