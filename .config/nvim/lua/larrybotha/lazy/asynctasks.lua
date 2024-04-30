return {
  'skywind3000/asynctasks.vim',
  dependencies = {
  'skywind3000/asyncrun.vim',
  },
  init = function()
    -- open quickfix window automatically
    vim.g.asyncrun_open = 6
    vim.g.asynctasks_term_pos = 'floaterm'

    -- load from .config folder
    vim.g.asynctasks_extra_config = {
      '~/.config/asynctasks/tasks.ini',
    }
  end
}
