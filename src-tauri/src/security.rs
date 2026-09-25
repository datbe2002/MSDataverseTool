//! Security, read only: users, security roles, the roles a user has (directly
//! and through teams), a role's privileges, and what access a user has to a
//! record (`RetrievePrincipalAccess`) with the facts that explain it.

use crate::error::{AppError, AppResult};
use crate::metadata::get_json;
use crate::odata::{bool_field, formatted, get_all, guid, int, logical_name, opt_str, str_field, PREFER_ALL};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Serialize;
use serde_json::Value;

const PREFER_LABELS: &str = "odata.include-annotations=\"*\"";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub name: String,
    pub email: Option<String>,
    pub username: Option<String>,
    pub title: Option<String>,
    pub disabled: bool,
    /// 0 Read-Write, 1 Administrative, 2 Read, 3 Support User, 4 Non-interactive, 5 Delegated Admin.
    pub access_mode: i64,
    pub access_mode_label: String,
    /// An application user (has an Entra app id).
    pub application: bool,
    pub business_unit: String,
    pub business_unit_id: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    /// The root role this is a business unit copy of (itself for a root role).
    pub root_id: String,
    pub name: String,
    pub business_unit: String,
    pub managed: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TeamRoles {
    pub id: String,
    pub name: String,
    /// "Owner", "Access", "Security group", "Office group"…
    pub team_type: String,
    pub roles: Vec<Role>,
    /// This team's roles couldn't be read.
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserRoles {
    pub business_unit: String,
    pub business_unit_id: Option<String>,
    pub direct: Vec<Role>,
    pub teams: Vec<TeamRoles>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Privilege {
    /// e.g. "prvReadAccount".
    pub name: String,
    /// 1 User (Basic), 2 Business unit (Local), 3 Parent: child BUs (Deep), 4 Organization (Global).
    pub depth: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessCheck {
    /// "ReadAccess", "WriteAccess", …
    pub rights: Vec<String>,
    pub record_name: Option<String>,
    /// "UserOwned", "OrganizationOwned", "BusinessOwned"…
    pub ownership: String,
    pub owner: Option<String>,
    pub owner_id: Option<String>,
    /// "systemuser" or "team".
    pub owner_kind: Option<String>,
    pub owning_business_unit: Option<String>,
    pub owning_business_unit_id: Option<String>,
    pub user_business_unit: String,
    pub user_business_unit_id: Option<String>,
    /// The business units above the user's, nearest first (for "Parent: child BUs").
    pub user_business_unit_parents: Vec<String>,
    /// The owning BU's parents, nearest first.
    pub owning_business_unit_parents: Vec<String>,
}

pub fn parse_user(row: &Value) -> Option<User> {
    let access_mode = int(row, "accessmode").unwrap_or(0);
    Some(User {
        id: opt_str(row, "systemuserid")?,
        name: str_field(row, "fullname"),
        email: opt_str(row, "internalemailaddress"),
        username: opt_str(row, "domainname"),
        title: opt_str(row, "title"),
        disabled: bool_field(row, "isdisabled"),
        access_mode,
        access_mode_label: formatted(row, "accessmode").unwrap_or_default(),
        application: opt_str(row, "applicationid").is_some_and(|a| a != "00000000-0000-0000-0000-000000000000"),
        business_unit: formatted(row, "_businessunitid_value").unwrap_or_default(),
        business_unit_id: opt_str(row, "_businessunitid_value"),
    })
}

pub fn parse_role(row: &Value) -> Option<Role> {
    let id = opt_str(row, "roleid")?;
    Some(Role {
        root_id: opt_str(row, "_parentrootroleid_value").unwrap_or_else(|| id.clone()),
        id,
        name: str_field(row, "name"),
        business_unit: formatted(row, "_businessunitid_value").unwrap_or_default(),
        managed: bool_field(row, "ismanaged"),
    })
}

/// Privilege depth as a number: 1 User … 4 Organization.
pub fn depth_of(s: &str) -> Option<u8> {
    match s {
        "Basic" => Some(1),
        "Local" => Some(2),
        "Deep" => Some(3),
        "Global" => Some(4),
        _ => None,
    }
}

pub fn users(host: &str, token: &str) -> AppResult<Vec<User>> {
    let url = format!(
        "https://{}/api/data/v9.2/systemusers?$select=systemuserid,fullname,internalemailaddress,domainname,title,isdisabled,accessmode,applicationid,_businessunitid_value&$orderby=fullname",
        host
    );
    Ok(get_all(url, token, PREFER_ALL)?.iter().filter_map(parse_user).collect())
}

/// Root roles (one per role; the business unit copies share their privileges).
pub fn roles(host: &str, token: &str) -> AppResult<Vec<Role>> {
    let url = format!(
        "https://{}/api/data/v9.2/roles?$select=roleid,name,ismanaged,_businessunitid_value,_parentrootroleid_value&$filter=_parentroleid_value%20eq%20null&$orderby=name",
        host
    );
    Ok(get_all(url, token, PREFER_ALL)?.iter().filter_map(parse_role).collect())
}

fn roles_in(body: &Value, key: &str) -> Vec<Role> {
    let mut roles: Vec<Role> = body.get(key).and_then(|v| v.as_array()).into_iter().flatten().filter_map(parse_role).collect();
    roles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    roles
}

pub fn user_roles(host: &str, token: &str, user_id: &str) -> AppResult<UserRoles> {
    let user_id = guid(user_id, "user id")?;
    let base = format!("https://{}/api/data/v9.2", host);
    let role_select = "roleid,name,ismanaged,_businessunitid_value,_parentrootroleid_value";
    let url = format!(
        "{}/systemusers({})?$select=_businessunitid_value&$expand=systemuserroles_association($select={}),teammembership_association($select=teamid,name,teamtype)",
        base, user_id, role_select
    );
    let user = get_json(&url, token, Some(PREFER_LABELS))?;
    let teams: Vec<(String, String, String)> = user
        .get("teammembership_association")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|t| Some((opt_str(t, "teamid")?, str_field(t, "name"), formatted(t, "teamtype").unwrap_or_default())))
        .collect();
    // Each team's roles, a few at a time.
    let mut team_roles: Vec<TeamRoles> = Vec::new();
    for chunk in teams.chunks(6) {
        let results: Vec<TeamRoles> = std::thread::scope(|s| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(id, name, team_type)| {
                    let url = format!("{}/teams({})/teamroles_association?$select={}", base, id, role_select);
                    s.spawn(move || {
                        let (roles, error) = match get_json(&url, token, Some(PREFER_LABELS)) {
                            Ok(body) => (roles_in(&body, "value"), None),
                            Err(e) => (Vec::new(), Some(e.to_string())),
                        };
                        TeamRoles { id: id.clone(), name: name.clone(), team_type: team_type.clone(), roles, error }
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        team_roles.extend(results);
    }
    team_roles.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(UserRoles {
        business_unit: formatted(&user, "_businessunitid_value").unwrap_or_default(),
        business_unit_id: opt_str(&user, "_businessunitid_value"),
        direct: roles_in(&user, "systemuserroles_association"),
        teams: team_roles,
    })
}

pub fn parse_privileges(body: &Value) -> Vec<Privilege> {
    let mut out: Vec<Privilege> = body
        .get("RolePrivileges")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(Privilege {
                name: opt_str(p, "PrivilegeName")?,
                depth: depth_of(p.get("Depth")?.as_str()?)?,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn role_privileges(host: &str, token: &str, role_id: &str) -> AppResult<Vec<Privilege>> {
    let role_id = guid(role_id, "role id")?;
    let url = format!("https://{}/api/data/v9.2/RetrieveRolePrivilegesRole(RoleId=@id)?@id={}", host, role_id);
    Ok(parse_privileges(&get_json(&url, token, None)?))
}

/// "ReadAccess, WriteAccess" → ["ReadAccess", "WriteAccess"]; "None" → [].
pub fn parse_rights(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|r| !r.is_empty() && *r != "None").map(String::from).collect()
}

/// Business units above `bu_id`, nearest first (stops after 30 levels).
fn bu_parents(base: &str, token: &str, bu_id: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = bu_id.map(String::from);
    while let Some(id) = current.take() {
        if out.len() >= 30 {
            break;
        }
        let Ok(bu) = get_json(&format!("{}/businessunits({})?$select=_parentbusinessunitid_value", base, id), token, None) else { break };
        current = opt_str(&bu, "_parentbusinessunitid_value");
        if let Some(p) = &current {
            out.push(p.to_ascii_lowercase());
        }
    }
    out
}

pub fn principal_access(host: &str, token: &str, user_id: &str, table: &str, record_id: &str) -> AppResult<AccessCheck> {
    let user_id = guid(user_id, "user id")?;
    let record_id = guid(record_id, "record id")?;
    let table = logical_name(table, "table name")?;
    let base = format!("https://{}/api/data/v9.2", host);

    let meta = get_json(
        &format!("{}/EntityDefinitions(LogicalName='{}')?$select=EntitySetName,OwnershipType,PrimaryNameAttribute", base, table),
        token,
        None,
    )
    .map_err(|e| if e.to_string().contains("(404)") { AppError::msg(format!("There is no table named `{}`.", table)) } else { e })?;
    let set = str_field(&meta, "EntitySetName");
    let ownership = str_field(&meta, "OwnershipType");
    let primary_name = opt_str(&meta, "PrimaryNameAttribute");
    let user_owned = matches!(ownership.as_str(), "UserOwned" | "TeamOwned");

    let target = format!("{{\"@odata.id\":\"{}({})\"}}", set, record_id);
    let rights_url = format!(
        "{}/systemusers({})/Microsoft.Dynamics.CRM.RetrievePrincipalAccess(Target=@t)?@t={}",
        base,
        user_id,
        utf8_percent_encode(&target, NON_ALPHANUMERIC)
    );
    let mut select: Vec<&str> = primary_name.iter().map(String::as_str).collect();
    if user_owned {
        select.extend(["_ownerid_value", "_owningbusinessunit_value"]);
    }
    let record_url = format!("{}/{}({})?$select={}", base, set, record_id, if select.is_empty() { "createdon".to_string() } else { select.join(",") });
    let user_url = format!("{}/systemusers({})?$select=_businessunitid_value", base, user_id);

    let (rights, record, user) = std::thread::scope(|s| {
        let r = s.spawn(|| get_json(&rights_url, token, None));
        let rec = s.spawn(|| get_json(&record_url, token, Some(PREFER_LABELS)));
        let u = get_json(&user_url, token, Some(PREFER_LABELS));
        let join = |h: std::thread::ScopedJoinHandle<'_, AppResult<Value>>| h.join().unwrap_or_else(|_| Err(AppError::msg("request panicked")));
        (join(r), join(rec), u)
    });
    let rights = rights?;
    let record = record.map_err(|e| {
        if e.to_string().contains("(404)") {
            AppError::msg(format!("There is no {} record with id {}.", table, record_id))
        } else {
            e
        }
    })?;
    let user = user?;
    let user_bu_id = opt_str(&user, "_businessunitid_value");
    let owning_bu_id = opt_str(&record, "_owningbusinessunit_value");
    let (user_parents, owning_parents) = std::thread::scope(|s| {
        let a = s.spawn(|| bu_parents(&base, token, user_bu_id.as_deref()));
        let b = bu_parents(&base, token, owning_bu_id.as_deref());
        (a.join().unwrap_or_default(), b)
    });
    Ok(AccessCheck {
        rights: parse_rights(&str_field(&rights, "AccessRights")),
        record_name: primary_name.as_deref().and_then(|n| opt_str(&record, n)),
        ownership,
        owner: formatted(&record, "_ownerid_value"),
        owner_id: opt_str(&record, "_ownerid_value"),
        owner_kind: opt_str(&record, "_ownerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"),
        owning_business_unit: formatted(&record, "_owningbusinessunit_value"),
        owning_business_unit_id: owning_bu_id,
        user_business_unit: formatted(&user, "_businessunitid_value").unwrap_or_default(),
        user_business_unit_id: user_bu_id,
        user_business_unit_parents: user_parents,
        owning_business_unit_parents: owning_parents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn privileges_read_their_depth() {
        let body = json!({ "RolePrivileges": [
            { "PrivilegeName": "prvReadAccount", "Depth": "Global" },
            { "PrivilegeName": "prvCreateAccount", "Depth": "Basic" },
            { "PrivilegeName": "prvOdd", "Depth": "RecordFilter" },
            { "Depth": "Local" }
        ]});
        assert_eq!(
            parse_privileges(&body),
            vec![
                Privilege { name: "prvCreateAccount".into(), depth: 1 },
                Privilege { name: "prvReadAccount".into(), depth: 4 },
            ]
        );
    }

    #[test]
    fn users_roles_and_rights() {
        let u = parse_user(&json!({
            "systemuserid": "u", "fullname": "Nancy", "accessmode": 4,
            "accessmode@OData.Community.Display.V1.FormattedValue": "Non-interactive",
            "applicationid": "00000000-0000-0000-0000-000000000000",
            "_businessunitid_value@OData.Community.Display.V1.FormattedValue": "Contoso"
        }))
        .unwrap();
        assert!(!u.application);
        assert_eq!(u.access_mode_label, "Non-interactive");
        assert_eq!(u.business_unit, "Contoso");
        let r = parse_role(&json!({ "roleid": "r", "name": "Salesperson" })).unwrap();
        assert_eq!(r.root_id, "r");
        assert_eq!(parse_rights("ReadAccess, WriteAccess"), vec!["ReadAccess", "WriteAccess"]);
        assert!(parse_rights("None").is_empty());
        assert!(principal_access("x", "t", "bad", "account", "11111111-2222-3333-4444-555555555555").is_err());
        assert!(principal_access("x", "t", "11111111-2222-3333-4444-555555555555", "acc'ount", "11111111-2222-3333-4444-555555555555").is_err());
    }
}
