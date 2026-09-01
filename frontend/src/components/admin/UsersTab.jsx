import UsersAdmin from './UsersAdmin';

/** Thin "page" wrapper around UsersAdmin (which already has its own toolbar/heading — see that
 * file) so Users gets its own top-level nav tab instead of living at the bottom of Trucks &
 * Drivers. Mirrors JobAssignmentsTab.jsx's role here. */
export default function UsersTab({
  users, currentUserId, onCreateUser, onChangeUserRole, onDeleteUser,
  allowedExternalEmails, onAddAllowedExternalEmail, onRemoveAllowedExternalEmail,
}) {
  return (
    <section>
      <UsersAdmin
        users={users}
        currentUserId={currentUserId}
        onCreateUser={onCreateUser}
        onChangeRole={onChangeUserRole}
        onDeleteUser={onDeleteUser}
        allowedExternalEmails={allowedExternalEmails}
        onAddAllowedExternalEmail={onAddAllowedExternalEmail}
        onRemoveAllowedExternalEmail={onRemoveAllowedExternalEmail}
      />
    </section>
  );
}
